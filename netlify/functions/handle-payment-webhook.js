// Netlify Function to handle Stripe webhook events
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

exports.handler = async function(event, context) {
  // Verify this is a POST request
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Get the raw body (important for signature verification)
  const payload = event.body;
  const sig = event.headers['stripe-signature'];

  let stripeEvent;

  // Verify the event came from Stripe
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log(`Received Stripe webhook event: ${stripeEvent.type}`);

  // Handle the event based on its type
  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      
      // Extract data from the session
      const jobId = session.metadata.jobId;
      const paymentType = session.metadata.paymentType;
      const isPreAuth = session.metadata.isPreAuth === 'true';
      const amount = session.amount_total / 100; // Convert back from pennies
      
      console.log(`Processing completed checkout session for job ${jobId}, payment type: ${paymentType}, amount: £${amount}`);
      
      // Get the payment intent (to get the transaction ID)
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      const transactionId = paymentIntent.id;
      
      // Determine payment description
      let description;
      if (paymentType === 'excess') {
        description = isPreAuth ? 'Insurance Excess (Pre-Authorization)' : 'Insurance Excess';
      } else if (paymentType === 'deposit') {
        description = 'Deposit';
      } else {
        description = 'Balance Payment';
      }
      
      // Update HireHop with payment information
      await updateHireHop(jobId, amount, description, transactionId, isPreAuth);
      
      // Update Monday.com
      await updateMonday(jobId, paymentType, transactionId, isPreAuth);
      
      console.log('Payment processing completed successfully');
    }
    
    // Return a success response
    return { 
      statusCode: 200, 
      body: JSON.stringify({ received: true }) 
    };
  } catch (error) {
    console.log(`Webhook Error: ${error.message}`);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: error.message }) 
    };
  }
};

// Function to update HireHop
async function updateHireHop(jobId, amount, description, transactionId, isPreAuth) {
  const hireHopApiKey = process.env.HIREHOP_API_KEY;
  const hireHopApiUrl = process.env.HIREHOP_API_URL || 'https://api.hirehop.com/api/v1';
  
  if (!hireHopApiKey) {
    throw new Error('HireHop API key is not configured');
  }
  
  const apiHeaders = {
    'Authorization': `Bearer ${hireHopApiKey}`,
    'Content-Type': 'application/json'
  };
  
  console.log(`Updating HireHop for job ${jobId} with payment of £${amount}`);
  
  // For pre-authorizations, we might want to handle them differently
  // You might want to just add a note rather than recording a payment
  if (isPreAuth) {
    // Just add a note for pre-auth
    const noteData = {
      note: `Pre-Authorization processed via Stripe. Amount: £${amount}. Transaction ID: ${transactionId}. Link: https://dashboard.stripe.com/payments/${transactionId}`
    };
    
    await axios.post(`${hireHopApiUrl}/job/${jobId}/notes`, noteData, {
      headers: apiHeaders
    });
    
    console.log('Added pre-authorization note to HireHop');
  } else {
    // Record actual payment
    const paymentData = {
      amount,
      description,
      payment_method: 'Card',
      payment_reference: transactionId
    };
    
    await axios.post(`${hireHopApiUrl}/job/${jobId}/payments`, paymentData, {
      headers: apiHeaders
    });
    
    console.log('Recorded payment in HireHop');
    
    // Add note with Stripe transaction link
    const noteData = {
      note: `Payment processed via Stripe. Transaction ID: ${transactionId}. Link: https://dashboard.stripe.com/payments/${transactionId}`
    };
    
    await axios.post(`${hireHopApiUrl}/job/${jobId}/notes`, noteData, {
      headers: apiHeaders
    });
    
    console.log('Added payment note to HireHop');
  }
  
  return true;
}

// Function to update Monday.com
async function updateMonday(jobId, paymentType, transactionId, isPreAuth) {
  const mondayApiKey = process.env.MONDAY_API_KEY;
  const mondayBoardId = process.env.MONDAY_BOARD_ID;
  
  if (!mondayApiKey || !mondayBoardId) {
    throw new Error('Monday.com API key or Board ID is not configured');
  }
  
  const mondayApiUrl = 'https://api.monday.com/v2';
  
  console.log(`Updating Monday.com for job ${jobId}, payment type: ${paymentType}`);
  
  // Determine status updates based on payment type
  let paymentStatus = null;
  let excessStatus = null;
  
  if (paymentType === 'excess') {
    excessStatus = 'Paid';
  } else {
    // For deposit/balance payments, we need to check the current payment status
    // Fetch job details to determine if this payment completes the total due
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://ooosh-tours-payment-page.netlify.app';
    const jobDetailsUrl = `${siteUrl}/.netlify/functions/get-job-details?job=${jobId}`;
    
    const jobResponse = await axios.get(jobDetailsUrl);
    const jobDetails = jobResponse.data;
    
    // Check if this would complete the payment
    // We're assuming the payment we just processed isn't included in paidAmount yet
    const newPaymentAmount = parseFloat(jobDetails.remainingAmount);
    
    if (newPaymentAmount <= 0 || paymentType === 'balance') {
      paymentStatus = 'Paid in Full';
    } else if (paymentType === 'deposit') {
      paymentStatus = 'Balance to Pay';
    }
  }
  
  // Find the item ID in Monday.com that corresponds to this job
  const query = `
    query {
      items_by_column_values(board_id: ${mondayBoardId}, column_id: "job_number", column_value: "${jobId}") {
        id
      }
    }
  `;
  
  const response = await axios.post(mondayApiUrl, { query }, {
    headers: { 'Authorization': mondayApiKey }
  });
  
  if (!response.data || !response.data.data || !response.data.data.items_by_column_values || response.data.data.items_by_column_values.length === 0) {
    throw new Error(`No Monday.com item found for job ${jobId}`);
  }
  
  const itemId = response.data.data.items_by_column_values[0].id;
  
  console.log(`Found Monday.com item: ${itemId}`);
  
  // Update job status if needed
  if (paymentStatus) {
    const statusValue = JSON.stringify({ label: paymentStatus });
    
    const mutation = `
      mutation {
        change_column_value(item_id: ${itemId}, board_id: ${mondayBoardId}, column_id: "status", value: "${statusValue}") {
          id
        }
      }
    `;
    
    await axios.post(mondayApiUrl, { query: mutation }, {
      headers: { 'Authorization': mondayApiKey }
    });
    
    console.log(`Updated Monday.com job status to: ${paymentStatus}`);
  }
  
  // Update excess status if needed
  if (excessStatus) {
    const excessValue = JSON.stringify({ label: excessStatus });
    
    const mutation = `
      mutation {
        change_column_value(item_id: ${itemId}, board_id: ${mondayBoardId}, column_id: "excess_status", value: "${excessValue}") {
          id
        }
      }
    `;
    
    await axios.post(mondayApiUrl, { query: mutation }, {
      headers: { 'Authorization': mondayApiKey }
    });
    
    console.log(`Updated Monday.com excess status to: ${excessStatus}`);
  }
  
  // Add Stripe transaction link to the notes
  const updateText = `Stripe ${isPreAuth ? 'Pre-Authorization' : 'Payment'}: https://dashboard.stripe.com/payments/${transactionId}`;
  
  const mutation = `
    mutation {
      create_update(item_id: ${itemId}, body: "${updateText}") {
        id
      }
    }
  `;
  
  await axios.post(mondayApiUrl, { query: mutation }, {
    headers: { 'Authorization': mondayApiKey }
  });
  
  console.log('Added Stripe transaction link to Monday.com');
  
  return true;
}
