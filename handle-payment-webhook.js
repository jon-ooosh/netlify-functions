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

  // Handle the event based on its type
  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      
      // Extract data from the session
      const jobId = session.metadata.jobId;
      const paymentType = session.metadata.paymentType;
      const isPreAuth = session.metadata.isPreAuth === 'true';
      const amount = session.amount_total / 100; // Convert back from pennies
      
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
      
      // TODO: Update HireHop with payment information
      // For now, we'll just log the details
      console.log('Would update HireHop with:', {
        jobId,
        amount,
        description,
        transactionId
      });
      
      /* 
      TODO: Uncomment and replace with actual API call to HireHop
      
      // Update HireHop
      const hireHopApiKey = process.env.HIREHOP_API_KEY;
      const hireHopApiUrl = process.env.HIREHOP_API_URL;
      
      // Record payment
      await axios.post(`${hireHopApiUrl}/job/${jobId}/payments`, {
        amount,
        description,
        payment_method: 'Card',
        payment_reference: transactionId
      }, {
        headers: { 'Authorization': `Bearer ${hireHopApiKey}` }
      });
      
      // Add note with Stripe transaction link
      await axios.post(`${hireHopApiUrl}/job/${jobId}/notes`, {
        note: `Payment processed via Stripe. Transaction ID: ${transactionId}. Link: https://dashboard.stripe.com/payments/${transactionId}`
      }, {
        headers: { 'Authorization': `Bearer ${hireHopApiKey}` }
      });
      */
      
      // TODO: Update Monday.com with payment information
      // For now, we'll just log the details
      console.log('Would update Monday.com with:', {
        jobId,
        paymentType,
        transactionId
      });
      
      /* 
      TODO: Uncomment and replace with actual API call to Monday.com
      
      // Update Monday.com
      const mondayApiKey = process.env.MONDAY_API_KEY;
      const mondayApiUrl = 'https://api.monday.com/v2';
      const mondayBoardId = process.env.MONDAY_BOARD_ID;
      
      // Determine Monday.com status updates
      let paymentStatus = null;
      let excessStatus = null;
      
      if (paymentType === 'excess') {
        excessStatus = 'Paid';
      } else {
        // Determine job payment status
        // This is simplified; in production, check the actual remaining amount
        if (paymentType === 'balance') {
          paymentStatus = 'Paid in Full';
        } else if (paymentType === 'deposit') {
          paymentStatus = 'Balance to Pay';
        }
      }
      
      // Find the item ID in Monday.com
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
      
      const items = response.data.data.items_by_column_values;
      if (!items || items.length === 0) {
        throw new Error(`No Monday.com item found for job ${jobId}`);
      }
      
      const itemId = items[0].id;
      
      // Update payment status if needed
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
      }
      
      // Add Stripe transaction link to the notes
      const updateText = `Stripe Transaction: https://dashboard.stripe.com/payments/${transactionId}`;
      
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
      */
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
