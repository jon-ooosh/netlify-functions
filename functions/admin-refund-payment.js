// functions/admin-refund-payment.js - Process refunds for excess payments
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
    
    // STEP 2: Create negative HireHop deposit (refund)
    console.log('🏢 STEP 2: Creating HireHop refund deposit...');
    const hirehopResult = await createHireHopRefundDeposit(jobId, amount, reason, notes, stripeRefund?.id);
    
    if (!hirehopResult.success) {
      console.error('❌ HireHop refund deposit creation failed:', hirehopResult.error);
      
      // TODO: In production, you might want to reverse the Stripe refund here
      // since the HireHop refund failed
      
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create HireHop refund deposit',
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
✅ HireHop Refund Deposit: ${hirehopResult.depositId} created successfully`;
    
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
          hirehopDepositId: hirehopResult.depositId,
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

// Create HireHop negative deposit for refund using the proven working method
async function createHireHopRefundDeposit(jobId, amount, reason, notes, stripeRefundId) {
  try {
    console.log(`💸 Creating HireHop refund deposit: Job ${jobId}, Amount: -£${amount}`);
    
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
    
    // 🚨 EXACT WORKING DEPOSIT DATA (using NEGATIVE amount for refund)
    const depositData = {
      ID: 0, // Step 1: Always 0 for new deposits
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: -amount, // 🔧 NEGATIVE amount creates a refund
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
    
    console.log('💸 STEP 1: Creating refund deposit (negative amount) - using proven method');
    
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
      console.log(`✅ STEP 1 SUCCESS: Refund deposit ${parsedResponse.hh_id} created`);
      
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
      
      return {
        success: true,
        depositId: parsedResponse.hh_id,
        tasksResult: tasksResult
      };
    } else {
      console.log(`❌ Refund deposit creation failed:`, parsedResponse);
      return {
        success: false,
        error: `HireHop refund deposit creation failed: ${JSON.stringify(parsedResponse)}`
      };
    }
    
  } catch (error) {
    console.error('❌ Error creating HireHop refund deposit:', error);
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
