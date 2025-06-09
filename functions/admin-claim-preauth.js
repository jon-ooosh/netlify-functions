// functions/admin-claim-preauth.js - FIXED: Proper payment method handling for pre-auth claims
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const { validateSessionToken } = require('./admin-auth');

exports.handler = async (event, context) => {
  try {
    console.log('🔐 ADMIN PRE-AUTH CLAIM: Starting claim process');
    
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Preflight call successful' }) };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    
    // Validate admin session
    const authHeader = event.headers.authorization;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin authentication not configured' }) };
    }
    
    const tokenValidation = validateSessionToken(authHeader, adminPassword);
    if (!tokenValidation.valid) {
      console.log(`❌ Invalid admin token: ${tokenValidation.error}`);
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }
    
    // Parse request body
    let requestData;
    try {
      requestData = JSON.parse(event.body);
    } catch (parseError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
    }
    
    const { jobId, amount, reason, notes, setupIntentId } = requestData;
    
    // Validate required fields
    if (!jobId || !amount || !reason) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: jobId, amount, reason' }) };
    }
    
    if (amount <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Amount must be greater than zero' }) };
    }
    
    console.log(`🔐 Processing claim: Job ${jobId}, Amount: £${amount}, Reason: ${reason}`);
    
    // STEP 1: Validate and retrieve the setup intent from Stripe
    console.log('🔍 STEP 1: Validating setup intent...');
    let setupIntent;
    
    if (setupIntentId) {
      try {
        setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
        console.log(`✅ Setup intent retrieved: ${setupIntent.id}, Status: ${setupIntent.status}`);
        
        if (setupIntent.status !== 'succeeded') {
          throw new Error(`Setup intent status is ${setupIntent.status}, expected 'succeeded'`);
        }
        
        // Check if we can claim from this setup intent
        if (!setupIntent.payment_method) {
          throw new Error('Setup intent has no attached payment method');
        }
        
      } catch (stripeError) {
        console.error('❌ Stripe setup intent error:', stripeError);
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ 
            error: 'Invalid setup intent', 
            details: stripeError.message 
          }) 
        };
      }
    }
    
    // STEP 2: Create Stripe payment intent to claim the amount
    console.log('💳 STEP 2: Creating Stripe payment intent for claim...');
    let paymentIntent;
    
    try {
      // 🔧 FIXED: First retrieve the customer from the setup intent
      const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);
      console.log(`💳 Retrieved payment method: ${paymentMethod.id}, Customer: ${paymentMethod.customer}`);
      
      // If payment method isn't attached to a customer, we need to create one
      let customerId = paymentMethod.customer;
      
      if (!customerId) {
        console.log('👤 No customer found, creating one...');
        
        // Create a customer first
        const customer = await stripe.customers.create({
          description: `Admin claim customer for job ${jobId}`,
          metadata: {
            jobId: jobId.toString(),
            createdFor: 'admin_claim',
            originalSetupIntent: setupIntentId
          }
        });
        
        customerId = customer.id;
        console.log(`✅ Created customer: ${customerId}`);
        
        // Attach the payment method to the customer
        await stripe.paymentMethods.attach(setupIntent.payment_method, {
          customer: customerId
        });
        
        console.log(`✅ Attached payment method to customer`);
      }
      
      // 🔧 FIXED: Create payment intent with the customer and payment method
      const paymentIntentData = {
        amount: Math.round(amount * 100), // Convert to pence
        currency: 'gbp',
        customer: customerId,
        payment_method: setupIntent.payment_method,
        confirmation_method: 'automatic',
        confirm: true,
        metadata: {
          jobId: jobId.toString(),
          paymentType: 'excess_claim',
          originalSetupIntent: setupIntentId,
          claimReason: reason,
          adminClaim: 'true'
        },
        description: `Excess claim for job ${jobId}: ${reason}`
      };
      
      console.log('💳 Creating payment intent with customer...');
      paymentIntent = await stripe.paymentIntents.create(paymentIntentData);
      
      console.log(`✅ Payment intent created and confirmed: ${paymentIntent.id}, Status: ${paymentIntent.status}`);
      
      // Handle different payment statuses
      if (paymentIntent.status === 'requires_action') {
        // 3D Secure or similar - this shouldn't happen for pre-auth claims usually
        console.log('⚠️ Payment requires additional action (3D Secure)');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: false,
            requiresAction: true,
            clientSecret: paymentIntent.client_secret,
            message: 'Payment requires additional authentication'
          })
        };
      } else if (paymentIntent.status !== 'succeeded') {
        throw new Error(`Payment failed with status: ${paymentIntent.status}`);
      }
      
    } catch (stripeError) {
      console.error('❌ Stripe payment intent error:', stripeError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Failed to process Stripe claim',
          details: stripeError.message
        })
      };
    }
    
    // STEP 3: Create HireHop deposit using the proven working method
    console.log('🏢 STEP 3: Creating HireHop deposit...');
    const hirehopResult = await createHireHopDepositForClaim(jobId, amount, reason, notes, paymentIntent.id);
    
    if (!hirehopResult.success) {
      console.error('❌ HireHop deposit creation failed:', hirehopResult.error);
      
      // TODO: In production, you might want to refund the Stripe payment here
      // since the deposit creation failed
      
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create HireHop deposit',
          details: hirehopResult.error,
          stripePaymentId: paymentIntent.id
        })
      };
    }
    
    // STEP 4: Add HireHop note about the claim
    console.log('📝 STEP 4: Adding HireHop note...');
    const noteText = `🔐 EXCESS CLAIM PROCESSED: £${amount.toFixed(2)} claimed from pre-authorisation
💳 Stripe Payment: ${paymentIntent.id}
🔗 Original Setup Intent: ${setupIntentId}
📋 Reason: ${reason}
${notes ? `💬 Notes: ${notes}` : ''}
✅ HireHop Deposit: ${hirehopResult.depositId} created successfully`;
    
    await addHireHopNote(jobId, noteText);
    
    // STEP 5: Future Monday.com integration (placeholder for now)
    console.log('📋 STEP 5: Monday.com integration (future)...');
    // TODO: Update Monday.com status when ready
    
    console.log(`✅ PRE-AUTH CLAIM COMPLETE: £${amount} claimed successfully`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Successfully claimed £${amount.toFixed(2)} from pre-authorisation`,
        claimDetails: {
          jobId: jobId,
          amount: amount,
          reason: reason,
          stripePaymentId: paymentIntent.id,
          setupIntentId: setupIntentId,
          hirehopDepositId: hirehopResult.depositId
        }
      })
    };
    
  } catch (error) {
    console.error('❌ Admin claim error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// Create HireHop deposit for claimed amount using the proven working method
async function createHireHopDepositForClaim(jobId, amount, reason, notes, stripePaymentId) {
  try {
    console.log(`💰 Creating HireHop deposit: Job ${jobId}, Amount: £${amount}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      throw new Error('HireHop API token not configured');
    }
    
    // Get client ID for this job
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // Create description and memo
    const description = `${jobId} - Excess claim: ${reason}`;
    const currentDate = new Date().toISOString().split('T')[0];
    const stripeUrl = `https://dashboard.stripe.com/payments/${stripePaymentId}`;
    
    let memo = `Stripe: ${stripeUrl}`;
    if (notes) {
      memo += ` | Notes: ${notes}`;
    }
    
    // 🚨 EXACT WORKING DEPOSIT DATA (from proven pattern)
    const depositData = {
      ID: 0, // Step 1: Always 0 for new deposits
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: memo,
      ACC_ACCOUNT_ID: 267, // Stripe GBP bank account
      local: new Date().toISOString().replace('T', ' ').substring(0, 19),
      tz: 'Europe/London',
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[NAME]': 'United Kingdom Pound',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      'CURRENCY[NEGATIVE_FORMAT]': 1,
      'CURRENCY[SYMBOL_POSITION]': 0,
      'CURRENCY[DECIMAL_SEPARATOR]': '.',
      'CURRENCY[THOUSAND_SEPARATOR]': ',',
      ACC_PACKAGE_ID: 3, // Xero - Main accounting package
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    console.log('💰 STEP 1: Creating deposit (ID: 0) - using proven method');
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = responseText;
    }
    
    if (response.ok && parsedResponse.hh_id) {
      console.log(`✅ STEP 1 SUCCESS: Deposit ${parsedResponse.hh_id} created`);
      
      // 🎯 CRITICAL: Call tasks.php for Xero sync (the proven solution)
      console.log('🔄 STEP 2: Triggering accounting tasks endpoint for Xero sync');
      
      const tasksResult = await triggerAccountingTasks(
        parsedResponse.hh_id,
        3, // ACC_PACKAGE_ID
        1, // PACKAGE_TYPE  
        token,
        hirehopDomain
      );
      
      console.log('📋 Tasks endpoint result:', tasksResult);
      
      // 🔄 STEP 3: Edit call as backup (proven pattern)
      console.log('🔄 STEP 3: Edit call as backup method');
      depositData.ID = parsedResponse.hh_id;
      
      const editResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(depositData).toString()
      });
      
      console.log('🔄 STEP 3 COMPLETED: Edit call made as backup');
      
      return {
        success: true,
        depositId: parsedResponse.hh_id,
        tasksResult: tasksResult
      };
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      return {
        success: false,
        error: `HireHop deposit creation failed: ${JSON.stringify(parsedResponse)}`
      };
    }
    
  } catch (error) {
    console.error('❌ Error creating HireHop deposit:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 🎯 THE CRITICAL DISCOVERED SOLUTION: Trigger accounting tasks (from proven pattern)
async function triggerAccountingTasks(depositId, accPackageId, packageType, token, hirehopDomain) {
  try {
    const tasksData = {
      hh_package_type: packageType,
      hh_acc_package_id: accPackageId,
      hh_task: 'post_deposit',
      hh_id: depositId,
      hh_acc_id: '',
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/accounting/tasks.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tasksData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    const success = response.ok && !responseText.includes('login') && !responseText.toLowerCase().includes('error');
    
    return { success: success, response: parsedResponse, httpStatus: response.status };
    
  } catch (error) {
    console.error('❌ Error calling tasks.php:', error);
    return { success: false, error: error.message };
  }
}

// Get job client ID (from proven pattern)
async function getJobClientId(jobId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(jobDataUrl);
    const jobData = await response.json();
    
    if (jobData && jobData.CLIENT_ID) {
      return jobData.CLIENT_ID;
    } else {
      console.log('⚠️ Could not get client ID, using fallback');
      return 1822; // Fallback client ID
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822; // Fallback client ID
  }
}

// Add HireHop note (from proven pattern)
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    console.log(`📝 HireHop note added: ${response.ok ? 'Success' : 'Failed'}`);
    return response.ok;
  } catch (error) {
    console.error('❌ Error adding HireHop note:', error);
    return false;
  }
}
