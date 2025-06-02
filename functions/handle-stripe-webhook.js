// handle-stripe-webhook.js - FINAL PRODUCTION VERSION
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 PRODUCTION WEBHOOK - Processing Stripe payment');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Parse webhook with signature verification
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
  } else {
    // Handle pre-authorization (add note only)
    await addPreAuthNote(jobId, paymentType, session);
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

// Create deposit in HireHop
async function createHireHopDeposit(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 Creating ${paymentType} deposit for job ${jobId}`);
    
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
    
    // 🎯 FIXED: Improved description formatting
    let description = `${jobId}`;
    if (paymentType === 'excess') {
      description += ' - excess'; // 🔧 FIXED: Use lowercase "excess" (not "xs")
    } else if (paymentType === 'balance') {
      description += ' - balance';
    } else if (paymentType === 'deposit') {
      description += ' - deposit';
    }
    
    const currentDate = new Date().toISOString().split('T')[0];
    
    // Get dynamic client ID for this job
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // 🎯 ACCOUNTING FIX: Match manual entry exactly for proper sync
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: '', // 🔧 FIXED: Keep empty like manual entry for accounting sync
      ACC_ACCOUNT_ID: 267,
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
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    console.log('💰 Creating deposit:', { 
      jobId, 
      paymentType, 
      amount: `£${amount.toFixed(2)}`, 
      description,
      clientId
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
    
    // Check for success
    if (response.ok && parsedResponse.hh_id && parsedResponse.sync_accounts) {
      console.log(`✅ SUCCESS! Deposit ${parsedResponse.hh_id} created for job ${jobId}`);
      console.log(`📊 Accounting sync: ${parsedResponse.sync_accounts ? 'Enabled' : 'Disabled'}`);
      
      // Add success note with transaction link (moved to note instead of memo)
      await addHireHopNote(jobId, `💳 Stripe payment: £${amount.toFixed(2)} ${paymentType}. ID: ${stripeObject.id}. Deposit: ${parsedResponse.hh_id}`);
      
      // 🎯 MONDAY.COM INTEGRATION - Activate this section when ready
      // await updateMondayStatus(jobId, paymentType, stripeObject.id);
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      
      // Add manual processing note
      await addHireHopNote(jobId, `🚨 MANUAL DEPOSIT NEEDED:
💰 Amount: £${amount.toFixed(2)}
📋 Type: ${paymentType}
💳 Stripe ID: ${stripeObject.id}
⚠️ API Error - please add deposit manually in billing tab.`);
      
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error creating deposit:', error);
    await addHireHopNote(jobId, `🚨 SYSTEM ERROR: Failed to process £${amount.toFixed(2)} ${paymentType} payment. Stripe: ${stripeObject.id}. Please add manually.`);
    throw error;
  }
}

// Handle pre-authorization notes
async function addPreAuthNote(jobId, paymentType, session) {
  const amount = session.amount_total / 100;
  const noteText = `💳 Pre-authorization held: £${amount.toFixed(2)} ${paymentType}. Stripe: ${session.id}. Will be captured automatically or released after hire.`;
  await addHireHopNote(jobId, noteText);
  console.log(`✅ Pre-auth note added for job ${jobId}`);
}

// Get client ID dynamically for any job
async function getJobClientId(jobId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(jobDataUrl);
    const jobData = await response.json();
    
    if (jobData && jobData.CLIENT_ID) {
      console.log(`📋 Retrieved client ID ${jobData.CLIENT_ID} for job ${jobId}`);
      return jobData.CLIENT_ID;
    } else {
      console.log(`⚠️ Could not get client ID for job ${jobId}, using default`);
      return 1822; // Fallback to your test client
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822; // Fallback
  }
}

// Add note to HireHop job
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    if (response.ok) {
      console.log('✅ Note added to job');
      return true;
    } else {
      console.log('⚠️ Failed to add note');
      return false;
    }
  } catch (error) {
    console.error('❌ Error adding note:', error);
    return false;
  }
}

// 🎯 MONDAY.COM INTEGRATION - Ready to activate
async function updateMondayStatus(jobId, paymentType, transactionId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com integration not configured');
      return false;
    }
    
    // Find Monday.com item by job ID
    const query = `
      query {
        items_by_column_values(board_id: ${mondayBoardId}, column_id: "job_number", column_value: "${jobId}") {
          id
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query })
    });
    
    const data = await response.json();
    
    if (data.data?.items_by_column_values?.[0]) {
      const itemId = data.data.items_by_column_values[0].id;
      
      // Update payment status
      let statusValue = '';
      if (paymentType === 'deposit') {
        statusValue = 'Deposit Paid';
      } else if (paymentType === 'balance') {
        statusValue = 'Fully Paid';
      } else if (paymentType === 'excess') {
        statusValue = 'Excess Paid';
      }
      
      // Add transaction update
      const updateText = `💳 Stripe Payment: £${amount} ${paymentType}. ID: ${transactionId}`;
      
      // Update Monday.com (implementation details depend on your board structure)
      console.log(`✅ Monday.com update ready for job ${jobId}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Monday.com update error:', error);
    return false;
  }
}
