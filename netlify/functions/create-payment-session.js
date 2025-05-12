// create-payment-session.js - Creates Stripe payment or pre-auth sessions
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
    
    // Parse the request body
    const data = JSON.parse(event.body);
    const { jobId, paymentType, successUrl, cancelUrl } = data;
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }
    
    // Get job details using the get-job-details function
    const apiUrl = new URL(event.headers.host);
    apiUrl.pathname = '/.netlify/functions/get-job-details';
    apiUrl.searchParams.append('jobId', jobId);
    
    const jobResponse = await fetch(apiUrl.toString());
    const jobDetails = await jobResponse.json();
    
    if (jobResponse.status !== 200) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to fetch job details', details: jobDetails.error })
      };
    }
    
    // Determine amount and payment method based on paymentType
    let amount = 0;
    let paymentMode = 'payment';
    let description = '';
    
    switch (paymentType) {
      case 'deposit':
        if (jobDetails.financial.depositPaid) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Deposit already paid' })
          };
        }
        amount = Math.round(jobDetails.financial.depositAmount * 100); // Convert to pence
        description = `Deposit for booking #${jobId}`;
        break;
        
      case 'balance':
        if (jobDetails.financial.remainingAmount <= 0) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'No balance remaining' })
          };
        }
        amount = Math.round(jobDetails.financial.balanceAmount * 100); // Convert to pence
        description = `Balance payment for booking #${jobId}`;
        break;
        
      case 'excess':
        amount = 120000; // £1,200 in pence
        description = `Insurance excess for booking #${jobId}`;
        
        // Use pre-auth for shorter hires
        if (jobDetails.excess.method === 'pre-auth') {
          paymentMode = 'setup';
        }
        break;
        
      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid payment type' })
        };
    }
    
    // Create metadata for the session
    const metadata = {
      jobId,
      paymentType,
      customerName: jobDetails.customer.name,
      customerEmail: jobDetails.customer.email
    };
    
    let session;
    
    if (paymentMode === 'payment') {
      // Create a payment session
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'gbp',
              product_data: {
                name: description,
                metadata
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: cancelUrl,
        customer_email: jobDetails.customer.email,
        metadata
      });
    } else {
      // Create a setup session for pre-auth
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'setup',
        setup_intent_data: {
          metadata
        },
        success_url: successUrl + '?setup_intent={SETUP_INTENT}',
        cancel_url: cancelUrl,
        customer_email: jobDetails.customer.email,
        metadata
      });
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ sessionId: session.id, url: session.url })
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
