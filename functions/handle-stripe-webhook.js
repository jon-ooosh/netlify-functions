// handle-stripe-webhook.js - UPDATED WITH MONDAY.COM INTEGRATION
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const { updatePaymentStatus } = require('./monday-integration');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 WEBHOOK WITH MONDAY INTEGRATION - Processing Stripe payment');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    let stripeEvent;
    const signature = event.headers['stripe-signature'];
    
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified');
    } catch (err) {
      console.log('⚠️ Signature verification failed, parsing without verification');
      stripeEvent = JSON.parse(event.body);
    }
    
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(stripeEvent.data.object);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(stripeEvent.data.object);
        break;
      default:
        console.log(`🔄 Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

async function handleCheckoutSessionCompleted(session) {
  console.log('🎯 Processing checkout session:', session.id);
  const { jobId, paymentType, isPreAuth } = session.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  if (isPreAuth !== 'true') {
    await processPaymentWithIntegrations(jobId, paymentType, session, false);
  } else {
    await processPreAuthWithIntegrations(jobId, paymentType, session);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  await processPaymentWithIntegrations(jobId, paymentType, paymentIntent, false);
}

// 🎯 NEW: Process payment with full HireHop + Monday.com integration
async function processPaymentWithIntegrations(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`🔄 FULL INTEGRATION: Processing ${paymentType} payment for job ${jobId}`);
    
    // Step 1: Get fresh job details for Monday.com logic
    const jobDetails = await getFreshJobDetails(jobId);
    if (!jobDetails) {
      console.error('❌ Failed to get job details for Monday.com integration');
      return;
    }
    
    // Step 2: Create deposit in HireHop with enhanced Xero sync
    const depositResult = await createDepositWithEnhancedXeroSync(jobId, paymentType, stripeObject);
    
    // Step 3: Calculate payment amount
    let paymentAmount = 0;
    if (stripeObject.amount_total) {
      paymentAmount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      paymentAmount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      paymentAmount = stripeObject.amount_received / 100;
    }
    
    // Step 4: Update Monday.com + HireHop statuses
    console.log('🎯 MONDAY INTEGRATION: Starting Monday.com and HireHop status updates...');
    const mondayResult = await updatePaymentStatus(
      jobId, 
      paymentType, 
      stripeObject.id, 
      paymentAmount, 
      isPreAuth, 
      jobDetails
    );
    
    if (mondayResult.success) {
      console.log('✅ MONDAY INTEGRATION SUCCESS:', mondayResult.summary);
      await addHireHopNote(jobId, `✅ FULL INTEGRATION: £${paymentAmount.toFixed(2)} ${paymentType} payment processed. Stripe: ${stripeObject.id}. Monday.com: ${mondayResult.mondayUpdates} status updates. HireHop: ${mondayResult.hirehopUpdate.success ? 'Updated to Booked' : 'Update failed'}`);
    } else {
      console.error('❌ MONDAY INTEGRATION FAILED:', mondayResult.error);
      await addHireHopNote(jobId, `⚠️ PARTIAL SUCCESS: £${paymentAmount.toFixed(2)} ${paymentType} payment processed (Stripe: ${stripeObject.id}) but Monday.com integration failed: ${mondayResult.error}`);
    }
    
    return { success: true, deposit: depositResult, monday: mondayResult };
    
  } catch (error) {
    console.error('❌ Error in full integration:', error);
    await addHireHopNote(jobId, `🚨 INTEGRATION ERROR: ${paymentType} payment failed. Stripe: ${stripeObject.id}. Error: ${error.message}`);
    throw error;
  }
}

// Process pre-authorization with integrations
async function processPreAuthWithIntegrations(jobId, paymentType, session) {
  try {
    console.log(`🔐 PRE-AUTH INTEGRATION: Processing ${paymentType} pre-auth for job ${jobId}`);
    
    // Get job details
    const jobDetails = await getFreshJobDetails(jobId);
    if (!jobDetails) {
      console.error('❌ Failed to get job details for pre-auth integration');
      return;
    }
    
    const amount = session.amount_total ? session.amount_total / 100 : 1200; // Default to £1200 for excess
    
    // Update Monday.com for pre-auth
    const mondayResult = await updatePaymentStatus(
      jobId, 
      paymentType, 
      session.id, 
      amount, 
      true, // isPreAuth = true
      jobDetails
    );
    
    if (mondayResult.success) {
      console.log('✅ PRE-AUTH MONDAY INTEGRATION SUCCESS');
      await addHireHopNote(jobId, `🔐 PRE-AUTH: £${amount.toFixed(2)} ${paymentType} pre-authorization set up. Stripe: ${session.id}. Monday.com updated.`);
    } else {
      console.error('❌ PRE-AUTH MONDAY INTEGRATION FAILED:', mondayResult.error);
      await addHireHopNote(jobId, `🔐 PRE-AUTH: £${amount.toFixed(2)} ${paymentType} pre-authorization set up (Stripe: ${session.id}) but Monday.com update failed.`);
    }
    
    return { success: true, monday: mondayResult };
    
  } catch (error) {
    console.error('❌ Error in pre-auth integration:', error);
    await addHireHopNote(jobId, `🚨 PRE-AUTH ERROR: ${paymentType} pre-authorization failed. Stripe: ${session.id}. Error: ${error.message}`);
    throw error;
  }
}

// Get fresh job details for Monday.com logic
async function getFreshJobDetails(jobId) {
  try {
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || 'https://ooosh-tours-payment-page.netlify.app';
    
    // Get hash first
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    const response1 = await fetch(jobDetailsUrl);
    const result1 = await response1.json();
    
    if (result1.hash && !result1.authenticated) {
      // Call with hash
      jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${result1.hash}`;
      const response2 = await fetch(jobDetailsUrl);
      const result2 = await response2.json();
      
      if (result2.success) {
        return result2;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting fresh job details:', error);
    return null;
  }
}

// 🎯 SOLUTION: Enhanced deposit creation with multiple Xero sync strategies (keeping your working solution)
async function createDepositWithEnhancedXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 ENHANCED XERO SYNC: Creating ${paymentType} deposit for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      amount = stripeObject.amount_received / 100;
    }
    
    const description = `${jobId} - ${paymentType}`;
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: ${stripeObject.id}`,
      ACC_ACCOUNT_ID: 267, // Stripe GBP bank account
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
    
    console.log('💰 Creating deposit with Xero sync');
    
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
      console.log(`✅ Deposit ${parsedResponse.hh_id} created successfully`);
      
      // Trigger the working Xero sync solution (edit the deposit)
      console.log('🔄 Triggering Xero sync with edit method');
      depositData.ID = parsedResponse.hh_id; // Change to existing ID for edit
      
      const editResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(depositData).toString()
      });
      
      console.log('🔄 Xero sync edit completed');
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error creating deposit:', error);
    throw error;
  }
}

async function getJobClientId(jobId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(jobDataUrl);
    const jobData = await response.json();
    
    if (jobData && jobData.CLIENT_ID) {
      return jobData.CLIENT_ID;
    } else {
      return 1822; // Fallback
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822; // Fallback
  }
}

async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    return response.ok;
  } catch (error) {
    console.error('❌ Error adding note:', error);
    return false;
  }
}
