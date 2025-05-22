// handle-webhook.js - Processes Stripe webhooks and updates HireHop and Monday.com
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Verify the webhook signature
    const signature = event.headers['stripe-signature'];
    let stripeEvent;
    
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Webhook signature verification failed' })
      };
    }
    
    // Handle different event types
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const { jobId, paymentType } = session.metadata;
        
        // Handle different payment types
        if (session.mode === 'payment') {
          // Process regular payment
          await handlePaymentSuccess(session);
        } else if (session.mode === 'setup') {
          // Process pre-authorization
          await handlePreAuthSuccess(session);
        }
        
        break;
      }
      
      case 'setup_intent.succeeded': {
        const setupIntent = stripeEvent.data.object;
        await handlePreAuthSuccess(setupIntent);
        break;
      }
      
      // Add more event types as needed
      
      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

// Handle successful payment
async function handlePaymentSuccess(session) {
  const { jobId, paymentType } = session.metadata;
  
  try {
    // Update HireHop with payment information
    await updateHireHop(jobId, {
      paymentType,
      amount: session.amount_total / 100, // Convert from pence to pounds
      transactionId: session.payment_intent || session.id,
      method: 'card'
    });
    
    // Update Monday.com status
    await updateMondayStatus(jobId, paymentType);
    
    console.log(`Payment success recorded for job ${jobId}, type: ${paymentType}`);
  } catch (error) {
    console.error('Error handling payment success:', error);
    throw error;
  }
}

// Handle successful pre-authorization
async function handlePreAuthSuccess(setupIntent) {
  let jobId, paymentType;
  
  // Extract metadata from either setupIntent or its parent session
  if (setupIntent.metadata && setupIntent.metadata.jobId) {
    jobId = setupIntent.metadata.jobId;
    paymentType = setupIntent.metadata.paymentType;
  } else if (setupIntent.setup_intent_data && setupIntent.setup_intent_data.metadata) {
    jobId = setupIntent.setup_intent_data.metadata.jobId;
    paymentType = setupIntent.setup_intent_data.metadata.paymentType;
  }
  
  if (!jobId) {
    console.error('Missing jobId in pre-auth metadata');
    return;
  }
  
  try {
    // Update HireHop with pre-auth information
    await updateHireHop(jobId, {
      paymentType: 'excess_preauth',
      amount: 1200, // £1,200 pre-auth amount
      transactionId: setupIntent.id,
      method: 'card_preauth'
    });
    
    // Update Monday.com status for pre-auth
    await updateMondayStatus(jobId, 'excess_preauth');
    
    console.log(`Pre-auth success recorded for job ${jobId}`);
  } catch (error) {
    console.error('Error handling pre-auth success:', error);
    throw error;
  }
}

// Update HireHop with payment information
async function updateHireHop(jobId, paymentInfo) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    // Try to find the best endpoint to update payment data
    // Since we haven't identified the correct endpoint yet, we'll provide options
    
    // Option 1: Using the payment receipts API (if it exists)
    const paymentUrl = `https://${hirehopDomain}/api/add_payment.php`;
    
    const paymentData = {
      job_id: jobId,
      amount: paymentInfo.amount,
      method: paymentInfo.method,
      reference: paymentInfo.transactionId,
      notes: `Payment processed via Stripe: ${paymentInfo.paymentType}`
    };
    
    // Make the API request
    const response = await fetch(paymentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        ...paymentData
      })
    });
    
    const result = await response.text();
    console.log('HireHop update result:', result);
    
    // If the first option fails, we can try alternative approaches here
    // ...
    
    return true;
  } catch (error) {
    console.error('Error updating HireHop:', error);
    throw error;
  }
}

// Update Monday.com status
async function updateMondayStatus(jobId, paymentType) {
  try {
    const apiKey = process.env.MONDAY_API_KEY;
    const boardId = process.env.MONDAY_BOARD_ID;
    
    // Find the Monday.com item for this job
    const query = `
      query {
        items_by_column_values(board_id: ${boardId}, column_id: "job_id", column_value: "${jobId}") {
          id
          name
        }
      }
    `;
    
    const mondayResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query })
    });
    
    const mondayData = await mondayResponse.json();
    
    if (!mondayData.data || !mondayData.data.items_by_column_values || 
        mondayData.data.items_by_column_values.length === 0) {
      console.error(`No Monday.com item found for job ${jobId}`);
      return false;
    }
    
    const itemId = mondayData.data.items_by_column_values[0].id;
    
    // Determine the status value based on payment type
    let statusValue;
    switch (paymentType) {
      case 'deposit':
        statusValue = 'Deposit Paid';
        break;
      case 'balance':
        statusValue = 'Balance Paid';
        break;
      case 'excess':
        statusValue = 'Excess Paid';
        break;
      case 'excess_preauth':
        statusValue = 'Excess Pre-authorized';
        break;
      default:
        statusValue = 'Payment Received';
    }
    
    // Update the status column
    const mutationQuery = `
      mutation {
        change_column_value(
          board_id: ${boardId},
          item_id: ${itemId},
          column_id: "status",
          value: "{\\"label\\":\\"${statusValue}\\"}"
        ) {
          id
        }
      }
    `;
    
    const updateResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query: mutationQuery })
    });
    
    const updateResult = await updateResponse.json();
    console.log('Monday.com update result:', updateResult);
    
    return true;
  } catch (error) {
    console.error('Error updating Monday.com:', error);
    throw error;
  }
}
