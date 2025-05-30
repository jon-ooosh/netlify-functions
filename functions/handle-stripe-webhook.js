// handle-stripe-webhook.js - Routes payments to HireHop and pre-auths to Monday.com
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
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('Webhook signature verified, event type:', stripeEvent.type);
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Webhook signature verification failed' })
      };
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
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
    
  } catch (error) {
    console.error('Webhook error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

// Handle completed checkout sessions (both payments and pre-auths start here)
async function handleCheckoutSessionCompleted(session) {
  console.log('Processing checkout session:', session.id);
  
  const { jobId, paymentType, isPreAuth } = session.metadata;
  
  if (!jobId || !paymentType) {
    console.error('Missing required metadata in session:', session.metadata);
    return;
  }
  
  console.log(`Session for job ${jobId}, type: ${paymentType}, isPreAuth: ${isPreAuth}`);
  
  if (isPreAuth === 'true') {
    // This is a pre-authorization - update Monday.com only
    await updateMondayPreAuth(jobId, session);
  } else {
    // This is a regular payment - update HireHop
    await updateHireHopPayment(jobId, paymentType, session);
    // Also update Monday.com with payment status
    await updateMondayPayment(jobId, paymentType, session);
  }
}

// Handle successful setup intents (pre-auths)
async function handleSetupIntentSucceeded(setupIntent) {
  console.log('Processing setup intent:', setupIntent.id);
  
  const { jobId, paymentType } = setupIntent.metadata;
  
  if (!jobId) {
    console.error('Missing jobId in setup intent metadata:', setupIntent.metadata);
    return;
  }
  
  // Setup intents are always pre-auths - update Monday.com only
  await updateMondayPreAuth(jobId, setupIntent);
}

// Handle successful payment intents (regular payments)
async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('Processing payment intent:', paymentIntent.id);
  
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('Missing required metadata in payment intent:', paymentIntent.metadata);
    return;
  }
  
  // Payment intents are always regular payments - update HireHop
  await updateHireHopPayment(jobId, paymentType, paymentIntent);
}

// Update HireHop with payment information
async function updateHireHopPayment(jobId, paymentType, stripeObject) {
  try {
    console.log(`Updating HireHop for job ${jobId} with ${paymentType} payment`);
    
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
    
    // Determine payment description
    let description = '';
    switch (paymentType) {
      case 'deposit':
        description = 'Deposit payment via Stripe';
        break;
      case 'balance':
        description = 'Balance payment via Stripe';
        break;
      case 'excess':
        description = 'Insurance excess payment via Stripe';
        break;
      default:
        description = 'Payment via Stripe';
    }
    
    // Try different HireHop API endpoints for adding payments
    const encodedToken = encodeURIComponent(token);
    
    // Method 1: Try direct payment addition API
    try {
      const paymentUrl = `https://${hirehopDomain}/api/add_payment.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&reference=${stripeObject.id}&token=${encodedToken}`;
      
      console.log('Trying payment API:', paymentUrl.substring(0, paymentUrl.indexOf('token')));
      
      const response = await fetch(paymentUrl);
      const responseText = await response.text();
      
      console.log('HireHop payment API response:', responseText);
      
      if (response.ok && !responseText.includes('error')) {
        console.log('Payment successfully added to HireHop via payment API');
        
        // Add a note with Stripe transaction link
        await addHireHopNote(jobId, `Payment processed via Stripe. Transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
        
        return true;
      }
    } catch (error) {
      console.error('Payment API failed:', error.message);
    }
    
    // Method 2: Try deposit addition API
    try {
      const depositUrl = `https://${hirehopDomain}/api/add_deposit.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&reference=${stripeObject.id}&token=${encodedToken}`;
      
      console.log('Trying deposit API:', depositUrl.substring(0, depositUrl.indexOf('token')));
      
      const response = await fetch(depositUrl);
      const responseText = await response.text();
      
      console.log('HireHop deposit API response:', responseText);
      
      if (response.ok && !responseText.includes('error')) {
        console.log('Payment successfully added to HireHop via deposit API');
        
        // Add a note with Stripe transaction link
        await addHireHopNote(jobId, `Payment processed via Stripe. Transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}`);
        
        return true;
      }
    } catch (error) {
      console.error('Deposit API failed:', error.message);
    }
    
    // Method 3: At minimum, add a note about the payment
    console.log('Payment APIs failed, adding note instead');
    await addHireHopNote(jobId, `PAYMENT RECEIVED: £${amount} ${description}. Stripe ID: ${stripeObject.id}. Please manually record this payment in HireHop.`);
    
    return false;
    
  } catch (error) {
    console.error('Error updating HireHop:', error);
    throw error;
  }
}

// Add a note to HireHop job
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/add_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    
    console.log('Adding note to HireHop:', noteUrl.substring(0, noteUrl.indexOf('token')));
    
    const response = await fetch(noteUrl);
    const responseText = await response.text();
    
    console.log('HireHop note response:', responseText);
    
    return response.ok;
  } catch (error) {
    console.error('Error adding note to HireHop:', error);
    return false;
  }
}

// Update Monday.com with pre-authorization information
async function updateMondayPreAuth(jobId, stripeObject) {
  try {
    console.log(`Updating Monday.com for job ${jobId} with pre-authorization`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.error('Monday.com API credentials not configured');
      return false;
    }
    
    // Find the Monday.com item for this job
    const findItemQuery = `
      query {
        items_by_column_values(board_id: ${mondayBoardId}, column_id: "job_id", column_value: "${jobId}") {
          id
          name
        }
      }
    `;
    
    console.log('Searching for Monday.com item with job ID:', jobId);
    
    const findResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: findItemQuery })
    });
    
    const findResult = await findResponse.json();
    
    if (!findResult.data || !findResult.data.items_by_column_values || 
        findResult.data.items_by_column_values.length === 0) {
      console.error(`No Monday.com item found for job ${jobId}`);
      return false;
    }
    
    const itemId = findResult.data.items_by_column_values[0].id;
    console.log(`Found Monday.com item: ${itemId}`);
    
    // Update the excess status column to "Pre-authorized"
    const updateExcessQuery = `
      mutation {
        change_column_value(
          board_id: ${mondayBoardId},
          item_id: ${itemId},
          column_id: "excess_status",
          value: "{\\"label\\":\\"Pre-authorized\\"}"
        ) {
          id
        }
      }
    `;
    
    const updateResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: updateExcessQuery })
    });
    
    const updateResult = await updateResponse.json();
    console.log('Monday.com excess status update result:', updateResult);
    
    // Add an update with Stripe transaction link
    const addUpdateQuery = `
      mutation {
        create_update(
          item_id: ${itemId},
          body: "Insurance excess pre-authorized via Stripe. Transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/setup_intents/${stripeObject.id}"
        ) {
          id
        }
      }
    `;
    
    const updateAddResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: addUpdateQuery })
    });
    
    const updateAddResult = await updateAddResponse.json();
    console.log('Monday.com update add result:', updateAddResult);
    
    return true;
    
  } catch (error) {
    console.error('Error updating Monday.com for pre-auth:', error);
    return false;
  }
}

// Update Monday.com with payment information
async function updateMondayPayment(jobId, paymentType, stripeObject) {
  try {
    console.log(`Updating Monday.com for job ${jobId} with ${paymentType} payment`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.error('Monday.com API credentials not configured');
      return false;
    }
    
    // Find the Monday.com item for this job
    const findItemQuery = `
      query {
        items_by_column_values(board_id: ${mondayBoardId}, column_id: "job_id", column_value: "${jobId}") {
          id
          name
        }
      }
    `;
    
    const findResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: findItemQuery })
    });
    
    const findResult = await findResponse.json();
    
    if (!findResult.data || !findResult.data.items_by_column_values || 
        findResult.data.items_by_column_values.length === 0) {
      console.error(`No Monday.com item found for job ${jobId}`);
      return false;
    }
    
    const itemId = findResult.data.items_by_column_values[0].id;
    console.log(`Found Monday.com item: ${itemId}`);
    
    // Determine status update based on payment type
    let statusUpdate = '';
    let columnId = '';
    
    switch (paymentType) {
      case 'deposit':
        statusUpdate = 'Deposit Paid';
        columnId = 'payment_status'; // Adjust column ID as needed
        break;
      case 'balance':
        statusUpdate = 'Fully Paid';
        columnId = 'payment_status';
        break;
      case 'excess':
        statusUpdate = 'Paid';
        columnId = 'excess_status';
        break;
      default:
        statusUpdate = 'Payment Received';
        columnId = 'payment_status';
    }
    
    // Update the status column
    const updateStatusQuery = `
      mutation {
        change_column_value(
          board_id: ${mondayBoardId},
          item_id: ${itemId},
          column_id: "${columnId}",
          value: "{\\"label\\":\\"${statusUpdate}\\"}"
        ) {
          id
        }
      }
    `;
    
    const updateResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: updateStatusQuery })
    });
    
    const updateResult = await updateResponse.json();
    console.log('Monday.com status update result:', updateResult);
    
    // Calculate amount
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    }
    
    // Add an update with payment details
    const addUpdateQuery = `
      mutation {
        create_update(
          item_id: ${itemId},
          body: "${paymentType.charAt(0).toUpperCase() + paymentType.slice(1)} payment received: £${amount}. Stripe transaction: ${stripeObject.id}. View: https://dashboard.stripe.com/payments/${stripeObject.id}"
        ) {
          id
        }
      }
    `;
    
    const updateAddResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: addUpdateQuery })
    });
    
    const updateAddResult = await updateAddResponse.json();
    console.log('Monday.com update add result:', updateAddResult);
    
    return true;
    
  } catch (error) {
    console.error('Error updating Monday.com for payment:', error);
    return false;
  }
}
