// create-stripe-session.js - Fixed version with proper pre-auth support
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
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

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Parse the request body
    const data = JSON.parse(event.body);
    const { jobId, paymentType, amount, successUrl, cancelUrl } = data;
    
    console.log(`Stripe session request: jobId=${jobId}, paymentType=${paymentType}, amount=${amount}`);
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters: jobId, paymentType, successUrl, cancelUrl' })
      };
    }
    
    // Get job details using our v2 API
    const baseUrl = process.env.URL || `https://${event.headers.host}`;
    
    // For internal API calls, we need to generate a hash first
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    
    const jobResponse = await fetch(jobDetailsUrl);
    let jobDetails;
    
    if (jobResponse.status === 200) {
      jobDetails = await jobResponse.json();
      
      // If we get a hash response (no hash provided), we need to call again with hash
      if (jobDetails.hash && !jobDetails.authenticated) {
        jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${jobDetails.hash}`;
        const jobResponse2 = await fetch(jobDetailsUrl);
        jobDetails = await jobResponse2.json();
      }
    } else {
      const errorData = await jobResponse.json();
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch job details', details: errorData.error })
      };
    }
    
    if (!jobDetails.success) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch job details', details: jobDetails.error })
      };
    }
    
    console.log(`Job details retrieved successfully. Excess method: ${jobDetails.excess.method}`);
    
    // Determine payment details based on type
    let stripeAmount = 0;
    let description = '';
    let usePreAuth = false;
    let currency = jobDetails.financial.currency?.toLowerCase() || 'gbp';
    let statusMessage = '';
    
    switch (paymentType) {
      case 'deposit':
        if (jobDetails.financial.depositPaid) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Deposit already paid' })
          };
        }
        stripeAmount = Math.round(jobDetails.financial.requiredDeposit * 100); // Convert to pence
        description = `Deposit for job #${jobId} - ${jobDetails.jobData.customerName}`;
        statusMessage = 'Paying this deposit will secure your booking and change the status to "Booked"';
        usePreAuth = false; // Deposits are always regular payments
        break;
        
      case 'balance':
        if (jobDetails.financial.fullyPaid) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Job already fully paid' })
          };
        }
        stripeAmount = Math.round(Math.max(0, jobDetails.financial.remainingHireBalance) * 100);
        description = `Balance payment for job #${jobId} - ${jobDetails.jobData.customerName}`;
        statusMessage = 'This will complete your hire payment';
        usePreAuth = false; // Balance payments are always regular payments
        break;
        
      case 'excess':
        // Check excess payment method from job details
        if (jobDetails.excess.method === 'pre-auth' && jobDetails.excess.canPreAuth) {
          usePreAuth = true;
          description = `Insurance excess pre-authorization for job #${jobId} - ${jobDetails.jobData.customerName}`;
          statusMessage = 'Pre-authorization will be held but not charged unless needed';
        } else if (jobDetails.excess.method === 'payment' || jobDetails.excess.method === 'too_late') {
          usePreAuth = false;
          description = `Insurance excess payment for job #${jobId} - ${jobDetails.jobData.customerName}`;
          statusMessage = 'Payment will be charged and refunded after hire if unused';
        } else {
          // Too early or other issue
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ 
              error: 'Cannot process excess payment at this time',
              message: jobDetails.excess.description,
              method: jobDetails.excess.method
            })
          };
        }
        
        // Use provided amount or calculate from job details
        if (amount) {
          stripeAmount = Math.round(amount * 100);
        } else {
          const excessNeeded = Math.max(0, jobDetails.excess.amount - jobDetails.financial.excessPaid);
          stripeAmount = Math.round(excessNeeded * 100);
        }
        break;
        
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid payment type. Must be: deposit, balance, or excess' })
        };
    }
    
    if (stripeAmount <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Payment amount must be greater than zero' })
      };
    }
    
    console.log(`Creating Stripe session: amount=${stripeAmount}, usePreAuth=${usePreAuth}, description=${description}`);
    
    // Create metadata for the session
    const metadata = {
      jobId: jobId.toString(),
      paymentType,
      isPreAuth: usePreAuth.toString(),
      customerName: jobDetails.jobData.customerName || '',
      customerEmail: jobDetails.jobData.customerEmail || '',
      hireDays: jobDetails.jobData.hireDays?.toString() || '',
      jobName: jobDetails.jobData.jobName || ''
    };
    
    let session;
    
    if (usePreAuth) {
      // Create a setup session for pre-authorization
      console.log('Creating pre-authorization session');
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'setup',
        setup_intent_data: {
          metadata,
          usage: 'off_session' // Allows us to charge later without customer present
        },
        success_url: successUrl + `?session_id={CHECKOUT_SESSION_ID}&type=preauth&amount=${stripeAmount / 100}&payment_type=${paymentType}`,
        cancel_url: cancelUrl,
        customer_email: jobDetails.jobData.customerEmail,
        metadata
      });
    } else {
      // Create a regular payment session
      console.log('Creating regular payment session');
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: description,
                metadata
              },
              unit_amount: stripeAmount,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: successUrl + `?session_id={CHECKOUT_SESSION_ID}&type=payment&amount=${stripeAmount / 100}&payment_type=${paymentType}`,
        cancel_url: cancelUrl,
        customer_email: jobDetails.jobData.customerEmail,
        metadata
      });
    }
    
    console.log(`Stripe session created successfully: ${session.id}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        sessionId: session.id, 
        url: session.url,
        usePreAuth,
        amount: stripeAmount / 100, // Return amount in pounds for confirmation
        description,
        statusMessage,
        paymentType,
        jobDetails: {
          jobName: jobDetails.jobData.jobName,
          customerName: jobDetails.jobData.customerName,
          hireDays: jobDetails.jobData.hireDays,
          dates: `${jobDetails.jobData.startDate} to ${jobDetails.jobData.endDate}`
        }
      })
    };
    
  } catch (error) {
    console.error('Error creating Stripe session:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
