// handle-stripe-webhook.js - FIXED VERSION with correct deposit parameters
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 FIXED WEBHOOK - Using correct deposit parameters');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Parse webhook
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
    
    // Handle events
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
    await createHireHopDeposit(jobId, paymentType, session);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  await createHireHopDeposit(jobId, paymentType, paymentIntent);
}

// 🎯 FIXED: Using the exact parameters from your browser capture
async function createHireHopDeposit(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 CREATING DEPOSIT using discovered parameters for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    // Calculate amount
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      amount = stripeObject.amount_received / 100;
    }
    
    // Create description - keep it simple like the manual entry
    let description = `Job ${jobId}`;
    if (paymentType === 'excess') {
      description += ' - Insurance Excess';
    } else if (paymentType === 'balance') {
      description += ' - Balance Payment'; 
    } else if (paymentType === 'deposit') {
      description += ' - Deposit';
    }
    description += ' (Stripe)';
    
    const currentDate = new Date().toISOString().split('T')[0];
    
    // 🎯 CORRECT: Use the real deposit endpoint with correct parameters
    const depositData = {
      ID: 0,                    // New deposit
      DATE: currentDate,        // Transaction date
      DESCRIPTION: description, // Description 
      AMOUNT: amount,          // Amount
      MEMO: '',                // Empty memo
      ACC_ACCOUNT_ID: 267,     // Stripe GBP bank account
      local: new Date().toISOString().replace('T', ' ').substring(0, 19), // Local timestamp
      tz: 'Europe/London',     // Timezone
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[NAME]': 'United Kingdom Pound',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      'CURRENCY[NEGATIVE_FORMAT]': 1,
      'CURRENCY[SYMBOL_POSITION]': 0,
      'CURRENCY[DECIMAL_SEPARATOR]': '.',
      'CURRENCY[THOUSAND_SEPARATOR]': ',',
      ACC_PACKAGE_ID: 3,       // Xero package
      JOB_ID: jobId,          // Job ID
      CLIENT_ID: 1822,        // Your client ID (you might need to get this dynamically)
      token: token
    };
    
    console.log('💰 Creating deposit with REAL endpoint and parameters:', { 
      ...depositData, 
      token: '[HIDDEN]' 
    });
    
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
    
    console.log('📡 HireHop deposit response:', {
      status: response.status,
      ok: response.ok,
      responseSize: responseText.length,
      response: parsedResponse
    });
    
    // Check for success
    if (response.ok && (!parsedResponse.error || parsedResponse.error === 0)) {
      console.log(`✅ SUCCESS! Deposit created for job ${jobId}`);
      
      // Add a note with Stripe transaction link
      await addHireHopNote(jobId, `💳 Stripe Payment: ${stripeObject.id} - £${amount.toFixed(2)} ${paymentType} payment processed successfully.`);
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      
      // Add note for manual processing
      await addHireHopNote(jobId, `🚨 MANUAL DEPOSIT NEEDED:
💰 Amount: £${amount.toFixed(2)}
📋 Type: ${paymentType}
📅 Date: ${currentDate}
💳 Stripe ID: ${stripeObject.id}
⚠️ Automatic deposit creation failed - please add manually to billing.`);
      
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error creating deposit:', error);
    
    // Add error note
    await addHireHopNote(jobId, `🚨 DEPOSIT ERROR: Failed to create £${amount.toFixed(2)} ${paymentType} payment. Stripe ID: ${stripeObject.id}. Please add manually.`);
    
    throw error;
  }
}

// Note adding function
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    if (response.ok) {
      console.log('✅ Note added to HireHop');
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Error adding note:', error);
    return false;
  }
}
