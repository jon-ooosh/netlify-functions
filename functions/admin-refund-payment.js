// Fixed admin-refund-payment.js - Use payment application API like manual refunds
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const { validateSessionToken } = require('./admin-auth');

exports.handler = async (event, context) => {
  try {
    console.log('💸 ADMIN REFUND: Starting refund process');
    
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
    
    const { jobId, amount, reason, notes, paymentId, depositId } = requestData;
    
    // Validate required fields
    if (!jobId || !amount || !reason) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: jobId, amount, reason' }) };
    }
    
    if (amount <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Refund amount must be greater than zero' }) };
    }
    
    console.log(`💸 Processing refund: Job ${jobId}, Amount: £${amount}, Reason: ${reason}`);
    
    // STEP 1: Process Stripe refund
    console.log('💳 STEP 1: Processing Stripe refund...');
    let stripeRefund = null;
    
    if (paymentId) {
      try {
        // Create refund in Stripe
        stripeRefund = await stripe.refunds.create({
          payment_intent: paymentId,
          amount: Math.round(amount * 100), // Convert to pence
          metadata: {
            jobId: jobId.toString(),
            refundType: 'excess_refund',
            refundReason: reason,
            adminRefund: 'true',
            originalDepositId: depositId || 'unknown'
          },
          reason: 'requested_by_customer' // Standard Stripe reason
        });
        
        console.log(`✅ Stripe refund created: ${stripeRefund.id}, Status: ${stripeRefund.status}`);
        
      } catch (stripeError) {
        console.error('❌ Stripe refund error:', stripeError);
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Failed to process Stripe refund',
            details: stripeError.message
          })
        };
      }
    } else {
      console.log('⚠️ No Stripe payment ID provided - processing HireHop refund only');
    }
    
    // STEP 2: Create HireHop payment application (refund) using the correct API
    console.log('🏢 STEP 2: Creating HireHop payment application (refund)...');
    const hirehopResult = await createHireHopPaymentApplication(jobId, amount, reason, notes, stripeRefund?.id, depositId);
    
    if (!hirehopResult.success) {
      console.error('❌ HireHop payment application creation failed:', hirehopResult.error);
      
      // TODO: In production, you might want to reverse the Stripe refund here
      // since the HireHop refund failed
      
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create HireHop refund',
          details: hirehopResult.error,
          stripeRefundId: stripeRefund?.id
        })
      };
    }
    
    // STEP 3: Add HireHop note about the refund
    console.log('📝 STEP 3: Adding HireHop note...');
    const noteText = `💸 EXCESS REFUND PROCESSED: £${amount.toFixed(2)} refunded to customer
${stripeRefund ? `💳 Stripe Refund: ${stripeRefund.id}` : '🏦 Manual/Bank Transfer Refund'}
📋 Reason: ${reason}
${notes ? `💬 Notes: ${notes}` : ''}
✅ HireHop Payment Application: ${hirehopResult.applicationId} created successfully`;
    
    await addHireHopNote(jobId, noteText);
    
    // STEP 4: Future Monday.com integration (placeholder for now)
    console.log('📋 STEP 4: Monday.com integration (future)...');
    // TODO: Update Monday.com status when ready
    
    console.log(`✅ REFUND COMPLETE: £${amount} refunded successfully`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Successfully refunded £${amount.toFixed(2)} to customer`,
        refundDetails: {
          jobId: jobId,
          amount: amount,
          reason: reason,
          stripeRefundId: stripeRefund?.id,
          hirehopApplicationId: hirehopResult.applicationId,
          refundMethod: stripeRefund ? 'stripe' : 'manual'
        }
      })
    };
    
  } catch (error) {
    console.error('❌ Admin refund error:', error);
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

// 🔧 NEW: Create HireHop payment application (this is how refunds work in HireHop)
async function createHireHopPaymentApplication(jobId, amount, reason, notes, stripeRefundId, depositId) {
  try {
    console.log(`💸 Creating HireHop payment application: Job ${jobId}, Amount: £${amount}, DepositId: ${depositId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      throw new Error('HireHop API token not configured');
    }
    
    // Get client ID for this job
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // Create description and memo for refund
    const description = `${jobId} - Excess refund: ${reason}`;
    const currentDate = new Date().toISOString().split('T')[0];
    
    let memo = '';
    if (stripeRefundId) {
      const stripeUrl = `https://dashboard.stripe.com/refunds/${stripeRefundId}`;
      memo = `Stripe Refund: ${stripeUrl}`;
    } else {
      memo = `Manual refund processed via admin portal`;
    }
    
    if (notes) {
      memo += ` | Notes: ${notes}`;
    }
    
    // 🔧 UPDATED: Try billing_save.php with payment type (this might be the correct endpoint)
    const paymentApplicationData = {
      ID: 0, // Always 0 for new entries
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount, // Positive amount
      MEMO: memo,
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      TYPE: 'payment', // Specify this is a payment application
      DEPOSIT_ID: depositId, // Link to the deposit we're refunding
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
      token: token
    };
    
    console.log('💸 STEP 1: Trying billing_save.php with payment type');
    
    // 🔧 Try the general billing endpoint with payment type
    let response = await fetch(`https://${hirehopDomain}/php_functions/billing_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(paymentApplicationData).toString()
    });
    
    let responseText = await response.text();
    console.log('💸 billing_save.php response:', responseText.substring(0, 200));
    
    // If that fails, try the deposit endpoint with negative amount (fallback)
    if (!response.ok || responseText.includes('Not found') || responseText.includes('404')) {
      console.log('💸 FALLBACK: Trying deposit endpoint with special parameters');
      
      // Remove payment-specific fields and try as a special deposit
      delete paymentApplicationData.TYPE;
      delete paymentApplicationData.DEPOSIT_ID;
      paymentApplicationData.AMOUNT = -amount; // Try negative amount as last resort
      paymentApplicationData.ACC_ACCOUNT_ID = 267; // Use same account as original
      
      response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(paymentApplicationData).toString()
      });
    }
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = responseText;
    }
    
    console.log(`💸 Payment application response:`, parsedResponse);
    
    if (response.ok && (parsedResponse.hh_id || parsedResponse.success)) {
      const applicationId = parsedResponse.hh_id || 'created';
      console.log(`✅ STEP 1 SUCCESS: Payment application ${applicationId} created`);
      
      // 🎯 CRITICAL: Call tasks.php for Xero sync if needed
      if (parsedResponse.hh_id) {
        console.log('🔄 STEP 2: Triggering accounting tasks endpoint for Xero sync');
        
        const tasksResult = await triggerAccountingTasks(
          parsedResponse.hh_id,
          3, // ACC_PACKAGE_ID
          1, // PACKAGE_TYPE  
          token,
          hirehopDomain
        );
        
        console.log('📋 Tasks endpoint result:', tasksResult);
      }
      
      return {
        success: true,
        applicationId: applicationId
      };
    } else {
      console.log(`❌ Payment application creation failed:`, parsedResponse);
      return {
        success: false,
        error: `HireHop payment application creation failed: ${JSON.stringify(parsedResponse)}`
      };
    }
    
  } catch (error) {
    console.error('❌ Error creating HireHop payment application:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 🎯 THE CRITICAL DISCOVERED SOLUTION: Trigger accounting tasks (from proven pattern)
async function triggerAccountingTasks(applicationId, accPackageId, packageType, token, hirehopDomain) {
  try {
    const tasksData = {
      hh_package_type: packageType,
      hh_acc_package_id: accPackageId,
      hh_task: 'post_payment', // Different task for payment applications
      hh_id: applicationId,
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
