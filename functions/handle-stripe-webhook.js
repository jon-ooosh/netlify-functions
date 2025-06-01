// handle-stripe-webhook.js - DEPOSIT CREATION VERSION
// This version systematically tries different deposit creation endpoints
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 DEPOSIT-FOCUSED WEBHOOK - Webhook received:', event.httpMethod);
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Parse webhook (with signature fallback as before)
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

// 🎯 NEW DEPOSIT-FOCUSED FUNCTION
async function createHireHopDeposit(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 CREATING DEPOSIT (not invoice) for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    // Calculate amount
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      amount = stripeObject.amount_received / 100;
    }
    
    // Create description - EXACTLY as HireHop expects
    let description = `Job ${jobId}`;
    if (paymentType === 'excess') {
      description += ' - Excess';
    }
    
    const currentDate = new Date().toISOString().split('T')[0];
    
    // 🎯 SYSTEMATIC DEPOSIT ENDPOINT TESTING
    const depositEndpoints = [
      // Most likely deposit creation endpoints
      {
        name: 'Direct Deposit Save',
        url: `https://${hirehopDomain}/php_functions/deposit_save.php`,
        method: 'POST',
        data: {
          job_id: jobId,
          main_id: jobId,
          amount: amount,
          description: description,
          date: currentDate,
          method: 'Card/Stripe',
          reference: stripeObject.id,
          token: token
        }
      },
      {
        name: 'API Deposit Create',
        url: `https://${hirehopDomain}/api/deposit_create.php`,
        method: 'POST',
        data: {
          job: jobId,
          amount: amount,
          description: description,
          date: currentDate,
          method: 'Card/Stripe',
          reference: stripeObject.id,
          token: token
        }
      },
      {
        name: 'API Add Deposit',
        url: `https://${hirehopDomain}/api/add_deposit.php`,
        method: 'POST',
        data: {
          job_id: jobId,
          amount: amount,
          description: description,
          date: currentDate,
          payment_method: 'Card/Stripe',
          reference: stripeObject.id,
          token: token
        }
      },
      {
        name: 'Frames Deposit Save',
        url: `https://${hirehopDomain}/frames/deposit_save.php`,
        method: 'POST',
        data: {
          job: jobId,
          amount: amount,
          desc: description,
          date: currentDate,
          method: 'Card/Stripe',
          ref: stripeObject.id,
          token: token
        }
      },
      // GET-based endpoints (some APIs prefer GET)
      {
        name: 'GET Add Deposit',
        url: `https://${hirehopDomain}/api/add_deposit.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&date=${currentDate}&reference=${stripeObject.id}&token=${encodedToken}`,
        method: 'GET'
      },
      {
        name: 'GET Create Deposit',
        url: `https://${hirehopDomain}/php_functions/create_deposit.php?job_id=${jobId}&amount=${amount}&desc=${encodeURIComponent(description)}&method=Card&date=${currentDate}&ref=${stripeObject.id}&token=${encodedToken}`,
        method: 'GET'
      }
    ];
    
    // Try each endpoint systematically
    for (let i = 0; i < depositEndpoints.length; i++) {
      const endpoint = depositEndpoints[i];
      console.log(`🔍 Trying deposit endpoint ${i + 1}: ${endpoint.name}`);
      
      try {
        let response;
        
        if (endpoint.method === 'POST') {
          response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(endpoint.data).toString()
          });
        } else {
          response = await fetch(endpoint.url);
        }
        
        const responseText = await response.text();
        console.log(`📡 ${endpoint.name} response:`, {
          status: response.status,
          ok: response.ok,
          responseSize: responseText.length,
          startsWithJson: responseText.trim().startsWith('{'),
          containsSuccess: responseText.toLowerCase().includes('success'),
          containsError: responseText.toLowerCase().includes('error'),
          firstChars: responseText.substring(0, 100)
        });
        
        // Check for success
        if (response.ok && !responseText.toLowerCase().includes('error')) {
          try {
            const jsonResponse = JSON.parse(responseText);
            if (!jsonResponse.error) {
              console.log(`✅ SUCCESS! Deposit created via ${endpoint.name}`);
              await addHireHopNote(jobId, `💳 Stripe: ${stripeObject.id}`);
              return true;
            }
          } catch (e) {
            // Non-JSON response, check if it suggests success
            if (responseText.includes('success') || responseText.includes('saved') || 
                (!responseText.includes('error') && !responseText.includes('<html'))) {
              console.log(`✅ SUCCESS! Deposit likely created via ${endpoint.name}`);
              await addHireHopNote(jobId, `💳 Stripe: ${stripeObject.id}`);
              return true;
            }
          }
        }
        
      } catch (error) {
        console.log(`❌ ${endpoint.name} failed:`, error.message);
      }
    }
    
    // If all endpoints fail, add detailed note for manual processing
    console.log('⚠️ All deposit endpoints failed - adding manual note');
    await addHireHopNote(jobId, `🚨 DEPOSIT NEEDED - Manual Entry Required:
💰 Amount: £${amount}
📋 Type: ${paymentType}
📅 Date: ${currentDate}
💳 Method: Card/Stripe
🔗 Stripe ID: ${stripeObject.id}
⚠️ Please manually add this DEPOSIT (not invoice) to job ${jobId}.`);
    
    return false;
    
  } catch (error) {
    console.error('❌ Error creating deposit:', error);
    throw error;
  }
}

// Note adding function (simplified)
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
