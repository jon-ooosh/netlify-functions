// Netlify Function to create a Stripe Checkout session
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*', // In production, set this to your specific domain
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'Preflight call successful' })
    };
  }

  // Check if this is a POST request
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ message: 'Method not allowed' })
    };
  }

  // Get parameters
  let jobId, paymentType;
  
  if (event.httpMethod === 'POST') {
    // For POST requests, parameters are in the body
    try {
      const requestData = JSON.parse(event.body);
      jobId = requestData.jobId;
      paymentType = requestData.paymentType;
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid request body' })
      };
    }
  } else {
    // For GET requests, parameters are in query string
    jobId = event.queryStringParameters?.job;
    paymentType = event.queryStringParameters?.type;
  }
  
  if (!jobId || !paymentType) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Job ID and payment type are required' })
    };
  }

  try {
    // Get job details from our get-job-details function
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://ooosh-tours-payment-page.netlify.app';
    const jobDetailsUrl = `${siteUrl}/.netlify/functions/get-job-details?job=${jobId}`;
    
    console.log(`Fetching job details from: ${jobDetailsUrl}`);
    
    const jobResponse = await axios.get(jobDetailsUrl);
    const jobDetails = jobResponse.data;
    
    // Determine amount to charge based on payment type
    let amount = 0;
    let description = '';
    
    if (paymentType === 'deposit') {
      amount = jobDetails.depositAmount;
      description = `Deposit for Job #${jobId} - ${jobDetails.customerName}`;
    } else if (paymentType === 'balance') {
      amount = jobDetails.remainingAmount;
      description = `Balance payment for Job #${jobId} - ${jobDetails.customerName}`;
    } else if (paymentType === 'excess') {
      amount = 1200.00; // £1,200 for insurance excess
      const excessType = jobDetails.excessMethod === 'pre-auth' ? 'Pre-authorization' : 'Payment';
      description = `Insurance excess ${excessType} for Job #${jobId} - ${jobDetails.customerName}`;
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid payment type' })
      };
    }
    
    // Convert amount to pennies for Stripe
    const amountInPence = Math.round(amount * 100);
    
    // Create product name and descriptions that show clearly on statements
    const productName = `Ooosh Tours - ${paymentType === 'excess' ? 'Insurance Excess' : 'Van Hire'}`;
    
    // Create a more detailed metadata object
    const metadata = {
      jobId: jobId,
      paymentType: paymentType,
      customerName: jobDetails.customerName,
      isPreAuth: paymentType === 'excess' && jobDetails.hireDuration <= 4 ? 'true' : 'false',
      vatIncluded: 'true',
      vatRate: jobDetails.vatInfo ? jobDetails.vatInfo.rate.toString() : '0.20',
      hireDuration: jobDetails.hireDuration.toString()
    };
    
    // Capture method for excess pre-auths
    let captureMethod = 'automatic';
    if (paymentType === 'excess' && jobDetails.excessMethod === 'pre-auth') {
      captureMethod = 'manual';
    }
    
    // Create checkout session options
    const sessionOptions = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: productName,
            description: description
          },
          unit_amount: amountInPence,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://www.oooshtours.co.uk/payment-success?session_id={CHECKOUT_SESSION_ID}&job=${jobId}&type=${paymentType}`,
      cancel_url: `https://www.oooshtours.co.uk/payment?job=${jobId}&cancelled=true`,
      metadata: metadata,
      payment_intent_data: {
        capture_method: captureMethod,
        metadata: metadata
      },
      // Add customer email if available
      ...(jobDetails.customerEmail && { customer_email: jobDetails.customerEmail })
    };
    
    console.log('Creating Stripe checkout session with options:', JSON.stringify(sessionOptions, null, 2));
    
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create(sessionOptions);
    
    console.log('Checkout session created:', session.id);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        id: session.id,
        url: session.url 
      })
    };
  } catch (error) {
    console.log('Error:', error);
    
    // Determine the appropriate error message
    let message = 'Error creating checkout session';
    let details = error.message;
    
    if (error.response) {
      // Error from the job details API call
      message = 'Error fetching job details';
      details = error.response.data?.message || error.message;
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message, error: details })
    };
  }
};
