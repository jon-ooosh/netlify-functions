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
  const hireHopToken = process.env.HIREHOP_API_TOKEN;
  const hireHopDomain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
  
  if (!hireHopToken) {
    throw new Error('HireHop API token is not configured');
  }
  
  console.log(`Updating HireHop for job ${jobId} with payment of £${amount}`);
  
  try {
    // For pre-authorizations, just add a note (since it's not an actual payment)
    if (isPreAuth) {
      // Add note for pre-auth
      const noteText = `Pre-Authorization processed via Stripe. Amount: £${amount}. Transaction ID: ${transactionId}. Link: https://dashboard.stripe.com/payments/${transactionId}`;
      
      // Use the direct URL format that worked for our job_data endpoint
      const noteUrl = `https://${hireHopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodeURIComponent(hireHopToken)}`;
      
      await axios.get(noteUrl);
      
      console.log('Added pre-authorization note to HireHop');
    } else {
      // Record actual payment
      // Try the same URL format for payments
      const paymentUrl = `https://${hireHopDomain}/api/job_payment.php?job=${jobId}&amount=${amount}&description=${encodeURIComponent(description)}&method=Card&reference=${transactionId}&token=${encodeURIComponent(hireHopToken)}`;
      
      await axios.get(paymentUrl);
      
      console.log('Recorded payment in HireHop');
      
      // Add note with Stripe transaction link
      const noteText = `Payment processed via Stripe. Transaction ID: ${transactionId}. Link: https://dashboard.stripe.com/payments/${transactionId}`;
      const noteUrl = `https://${hireHopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodeURIComponent(hireHopToken)}`;
      
      await axios.get(noteUrl);
      
      console.log('Added payment note to HireHop');
    }
    
    return true;
  } catch (error) {
    console.error('Error updating HireHop:', error);
    throw new Error(`Failed to update HireHop: ${error.message}`);
  }
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
  
  try {
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
  } catch (error) {
    console.error('Error updating Monday.com:', error.message);
    throw new Error(`Failed to update Monday.com: ${error.message}`);
  }
}
