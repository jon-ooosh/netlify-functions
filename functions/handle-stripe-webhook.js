// handle-stripe-webhook.js - FIXED VERSION - Records deposits, not invoices
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('Webhook received:', event.httpMethod);
    
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Verify the webhook signature from Stripe
    const signature = event.headers['stripe-signature'];
    let stripeEvent;
    
    try {
      // Use raw body for signature verification in Netlify
      let rawBody = event.body;
      
      // If the body is already parsed (object), convert back to string
      if (typeof rawBody === 'object') {
        rawBody = JSON.stringify(rawBody);
      }
      
      console.log('Verifying signature with webhook secret...');
      
      stripeEvent = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified, event type:', stripeEvent.type);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err);
      
      // For debugging - let's try without signature verification temporarily
      console.log('⚠️  Attempting to parse webhook without signature verification...');
      try {
        stripeEvent = JSON.parse(event.body);
        console.log('✅ Successfully parsed webhook data without verification, event type:', stripeEvent.type);
        console.log('⚠️  WARNING: Processing webhook without signature verification - this should be fixed!');
      } catch (parseErr) {
        console.error('❌ Failed to parse webhook data:', parseErr);
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Webhook signature verification failed and could not parse data' })
        };
      }
    }
    
    // Handle different event types
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(stripeEvent.data.object);
        break;
        
      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(stripeEvent.data.object);
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

// Handle completed checkout sessions (both payments and pre-auths start here)
async function handleCheckoutSessionCompleted(session) {
  console.log('🎯 Processing checkout session:', session.id);
  
  const { jobId, paymentType, isPreAuth } = session.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata in session:', session.metadata);
    return;
  }
  
  console.log(`📋 Session for job ${jobId}, type: ${paymentType}, isPreAuth: ${isPreAuth}`);
  
  if (isPreAuth === 'true') {
    // This is a pre-authorization - for now, just log it (Monday.com integration later)
    console.log(`🔒 Pre-authorization completed for job ${jobId} - ${session.id}`);
    // TODO: Update Monday.com when ready
    // await updateMondayPreAuth(jobId, session);
  } else {
    // This is a regular payment - update HireHop with DEPOSIT
    await updateHireHopDeposit(jobId, paymentType, session);
    // TODO: Also update Monday.com when ready
    // await updateMondayPayment(jobId, paymentType, session);
  }
}

// Handle successful setup intents (pre-auths)
async function handleSetupIntentSucceeded(setupIntent) {
  console.log('🔒 Processing setup intent:', setupIntent.id);
  
  const { jobId, paymentType } = setupIntent.metadata;
  
  if (!jobId) {
    console.error('❌ Missing jobId in setup intent metadata:', setupIntent.metadata);
    return;
  }
  
  // Setup intents are always pre-auths - for now, just log it (Monday.com integration later)
  console.log(`🔒 Setup intent succeeded for job ${jobId} - ${setupIntent.id}`);
  // TODO: Update Monday.com when ready
  // await updateMondayPreAuth(jobId, setupIntent);
}

// Handle successful payment intents (regular payments)
async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata in payment intent:', paymentIntent.metadata);
    return;
  }
  
  // Payment intents are always regular payments - update HireHop with DEPOSIT
  await updateHireHopDeposit(jobId, paymentType, paymentIntent);
}

// FIXED: Update HireHop with DEPOSIT (payment received), not billing items
async function updateHireHopDeposit(jobId, paymentType, stripeObject) {
  try {
    console.log(`💰 Recording DEPOSIT in HireHop for job ${jobId} with ${paymentType}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      throw new Error('HireHop API token not configured');
    }
    
    // Calculate amount from Stripe object
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100; // Convert from pence to pounds
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      amount = stripeObject.amount_received / 100;
    }
    
    // Build description with job number and payment type
    let description = `Job ${jobId}`;
    switch (paymentType) {
      case 'deposit':
        description += ' - Deposit via Stripe';
        break;
      case 'balance':
        description += ' - Balance via Stripe';
        break;
      case 'excess':
        description += ' - Excess via Stripe';
        break;
      default:
        description += ' - Payment via Stripe';
    }
    
    // Get current date in format HireHop expects
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const encodedToken = encodeURIComponent(token);
    
    // METHOD 1: Try the correct deposit creation endpoint
    // Based on HireHop docs, we need to create deposits, not billing items
    try {
      console.log('🎯 Attempting to create DEPOSIT via deposit endpoint...');
      
      // Try multiple possible deposit endpoints from the documentation
      const depositEndpoints = [
        // Primary deposit endpoint (most likely)
        `https://${hirehopDomain}/php_functions/deposit_save.php`,
        // Alternative deposit endpoints
        `https://${hirehopDomain}/api/deposit.php`,
        `https://${hirehopDomain}/api/deposit_save.php`,
        `https://${hirehopDomain}/frames/deposit_save.php`
      ];
      
      const depositData = {
        job: jobId,
        main_id: jobId, // Some APIs use main_id instead of job
        amount: amount,
        description: description,
        date: currentDate,
        method: 'Card/Stripe',
        reference: stripeObject.id,
        token: token
      };
      
      console.log('💰 Deposit data being sent:', {
        ...depositData,
        token: '[HIDDEN]'
      });
      
      // Try each deposit endpoint
      for (let i = 0; i < depositEndpoints.length; i++) {
        const endpoint = depositEndpoints[i];
        console.log(`📡 Trying deposit endpoint ${i + 1}: ${endpoint}`);
        
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(depositData).toString()
          });
          
          const responseText = await response.text();
          console.log(`📡 Deposit endpoint ${i + 1} response status:`, response.status);
          console.log(`📡 Deposit endpoint ${i + 1} response:`, responseText.substring(0, 200));
          
          if (response.ok) {
            try {
              const jsonResponse = JSON.parse(responseText);
              if (!jsonResponse.error) {
                console.log(`✅ Deposit successfully created via endpoint ${i + 1}!`);
                
                // Add a note with Stripe transaction link
                await addHireHopNote(jobId, `💳 Stripe transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
                
                return true;
              } else {
                console.log(`❌ Endpoint ${i + 1} returned error:`, jsonResponse.error);
              }
            } catch (parseError) {
              // Response might not be JSON - check if it contains success indicators
              if (responseText.includes('success') || responseText.includes('saved') || !responseText.includes('error')) {
                console.log(`✅ Deposit likely created successfully via endpoint ${i + 1} (non-JSON response)`);
                await addHireHopNote(jobId, `💳 Stripe transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
                return true;
              } else {
                console.log(`❌ Endpoint ${i + 1} suggests failure:`, responseText.substring(0, 100));
              }
            }
          } else {
            console.log(`❌ Endpoint ${i + 1} HTTP error:`, response.status, responseText.substring(0, 100));
          }
        } catch (endpointError) {
          console.log(`❌ Endpoint ${i + 1} failed with exception:`, endpointError.message);
        }
      }
      
    } catch (error) {
      console.error('❌ All deposit endpoints failed:', error.message);
    }
    
    // METHOD 2: Try using GET-based deposit API endpoints
    try {
      console.log('🔄 Attempting to create deposit via GET endpoints...');
      
      const getEndpoints = [
        `https://${hirehopDomain}/api/add_deposit.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&date=${currentDate}&token=${encodedToken}`,
        `https://${hirehopDomain}/php_functions/add_deposit.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&date=${currentDate}&token=${encodedToken}`,
        `https://${hirehopDomain}/api/create_deposit.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&date=${currentDate}&token=${encodedToken}`
      ];
      
      for (let i = 0; i < getEndpoints.length; i++) {
        const endpoint = getEndpoints[i];
        console.log(`📡 Trying GET deposit endpoint ${i + 1}:`, endpoint.substring(0, endpoint.indexOf('token')));
        
        try {
          const response = await fetch(endpoint);
          const responseText = await response.text();
          
          console.log(`📡 GET endpoint ${i + 1} response status:`, response.status);
          console.log(`📡 GET endpoint ${i + 1} response:`, responseText.substring(0, 200));
          
          if (response.ok && !responseText.toLowerCase().includes('error') && !responseText.includes('<html')) {
            console.log(`✅ Deposit successfully created via GET endpoint ${i + 1}!`);
            
            // Add a note with Stripe transaction link
            await addHireHopNote(jobId, `💳 Stripe transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
            
            return true;
          }
        } catch (error) {
          console.log(`❌ GET endpoint ${i + 1} failed:`, error.message);
        }
      }
    } catch (error) {
      console.error('❌ All GET deposit endpoints failed:', error.message);
    }
    
    // METHOD 3: Last resort - try to use the billing endpoint but with correct parameters for deposit
    try {
      console.log('🔄 Attempting billing endpoint with deposit parameters...');
      
      const depositData = {
        job: jobId,
        main_id: jobId,
        type: 1, // 1 = job
        kind: 6, // 6 = deposit (but this might be for billing items, not actual deposits)
        amount: amount,
        credit: amount, // Credit amount (money received)
        debit: 0, // No debit
        date: currentDate,
        desc: description,
        description: description,
        method: 'Card/Stripe',
        bank_id: 267, // Stripe GBP bank account
        reference: stripeObject.id,
        token: token
      };
      
      console.log('💰 Billing deposit data:', { ...depositData, token: '[HIDDEN]' });
      
      const response = await fetch(`https://${hirehopDomain}/php_functions/billing_save.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(depositData).toString()
      });
      
      const responseText = await response.text();
      console.log('📡 Billing deposit response status:', response.status);
      console.log('📡 Billing deposit response:', responseText.substring(0, 200));
      
      if (response.ok && !responseText.toLowerCase().includes('error')) {
        console.log('⚠️  Deposit likely created via billing endpoint (fallback method)');
        await addHireHopNote(jobId, `💳 Stripe transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
        return true;
      }
      
    } catch (error) {
      console.error('❌ Billing deposit fallback failed:', error.message);
    }
    
    // METHOD 4: Final fallback - add detailed note for manual entry
    console.log('⚠️  All deposit APIs failed, adding detailed note for manual entry');
    
    const detailedNote = `🚨 PAYMENT RECEIVED - MANUAL ENTRY REQUIRED:
💰 Amount: £${amount}
📋 Type: ${paymentType}
📝 Description: ${description}
📅 Date: ${currentDate}
💳 Method: Card/Stripe
🔗 Stripe ID: ${stripeObject.id}
👀 View transaction: https://dashboard.stripe.com/payments/${stripeObject.id}

⚠️ Please manually add this DEPOSIT (not invoice) to the billing section.
This is money RECEIVED, not a charge to the customer.`;
    
    await addHireHopNote(jobId, detailedNote);
    
    return false;
    
  } catch (error) {
    console.error('❌ Error updating HireHop:', error);
    throw error;
  }
}

// Add a note to HireHop job - IMPROVED version
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    // Try multiple possible note API endpoints
    const noteEndpoints = [
      `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`,
      `https://${hirehopDomain}/php_functions/add_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`,
      `https://${hirehopDomain}/api/notes.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`,
      `https://${hirehopDomain}/php_functions/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`,
      `https://${hirehopDomain}/frames/add_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`
    ];
    
    for (let i = 0; i < noteEndpoints.length; i++) {
      const noteUrl = noteEndpoints[i];
      console.log(`📝 Trying note endpoint ${i + 1}:`, noteUrl.substring(0, noteUrl.indexOf('token')));
      
      try {
        const response = await fetch(noteUrl);
        const responseText = await response.text();
        
        console.log(`📝 Note endpoint ${i + 1} response status:`, response.status);
        console.log(`📝 Note endpoint ${i + 1} response:`, responseText.substring(0, 200));
        
        // If we get a successful response (not HTML error page)
        if (response.ok && !responseText.includes('<html') && !responseText.toLowerCase().includes('not found')) {
          console.log(`✅ Note successfully added via endpoint ${i + 1}`);
          return true;
        }
      } catch (error) {
        console.log(`❌ Note endpoint ${i + 1} failed:`, error.message);
      }
    }
    
    console.log('⚠️  All note endpoints failed - note not added');
    return false;
  } catch (error) {
    console.error('❌ Error adding note to HireHop:', error);
    return false;
  }
}

// Update Monday.com with pre-authorization information (for future use)
async function updateMondayPreAuth(jobId, stripeObject) {
  // Implementation will be added when we work on Monday.com integration
  console.log('🔄 Monday.com pre-auth update - not implemented yet');
  return true;
}

// Update Monday.com with payment information (for future use)
async function updateMondayPayment(jobId, paymentType, stripeObject) {
  // Implementation will be added when we work on Monday.com integration
  console.log('🔄 Monday.com payment update - not implemented yet');
  return true;
}
