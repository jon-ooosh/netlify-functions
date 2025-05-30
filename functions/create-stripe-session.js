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
    
    // Parse the request body with detailed error logging
    let data;
    try {
      console.log('Raw request body:', event.body);
      data = JSON.parse(event.body);
      console.log('Parsed request data:', data);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body', details: parseError.message })
      };
    }
    
    const { jobId, paymentType, amount, successUrl, cancelUrl } = data;
    
    console.log(`Stripe session request: jobId=${jobId}, paymentType=${paymentType}, amount=${amount}`);
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters: jobId, paymentType, successUrl, cancelUrl' })
      };
    }
    
    // Get job details using our v2 API with better error handling
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || `https://${event.headers.host}`;
    console.log('Base URL for API calls:', baseUrl);
    
    // First get the hash
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    console.log('Making initial job details request to:', jobDetailsUrl);
    
    let jobResponse;
    try {
      jobResponse = await fetch(jobDetailsUrl);
      console.log('Initial job response status:', jobResponse.status);
    } catch (fetchError) {
      console.error('Failed to fetch job details:', fetchError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to connect to job details API', details: fetchError.message })
      };
    }
    let jobDetails;
    
    if (jobResponse.status === 200) {
      try {
        jobDetails = await jobResponse.json();
        console.log('Job details response:', { success: jobDetails.success, authenticated: jobDetails.authenticated, hasHash: !!jobDetails.hash });
      } catch (jsonError) {
        console.error('Failed to parse job details JSON:', jsonError);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Invalid response from job details API', details: jsonError.message })
        };
      }
      
      // If we get a hash response (no hash provided), we need to call again with hash
      if (jobDetails.hash && !jobDetails.authenticated) {
        jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${jobDetails.hash}`;
        console.log('Making authenticated job details request to:', jobDetailsUrl);
        
        try {
          const jobResponse2 = await fetch(jobDetailsUrl);
          console.log('Authenticated job response status:', jobResponse2.status);
          
          if (!jobResponse2.ok) {
            const errorText = await jobResponse2.text();
            console.error('Authenticated job details failed:', errorText);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to fetch authenticated job details', details: errorText })
            };
          }
          
          jobDetails = await jobResponse2.json();
          console.log('Authenticated job details received:', { success: jobDetails.success });
        } catch (fetchError2) {
          console.error('Failed to fetch authenticated job details:', fetchError2);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch authenticated job details', details: fetchError2.message })
          };
        }
      }
    } else {
      try {
        const errorData = await jobResponse.json();
        console.error('Job details API error:', errorData);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Failed to fetch job details', details: errorData.error || 'Unknown error' })
        };
      } catch (jsonError) {
        const errorText = await jobResponse.text();
        console.error('Job details API error (raw):', errorText);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Failed to fetch job details', details: errorText })
        };
      }
    }
    
    if (!jobDetails.success) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch job details', details: jobDetails.error })
      };
    }
    
    console.log(`Job details retrieved successfully. Excess method: ${jobDetails.excess?.method || 'N/A'}`);
    
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
        // FIXED: Check excess payment method from job details
        console.log(`Excess payment - method: ${jobDetails.excess.method}, canPreAuth: ${jobDetails.excess.canPreAuth}`);
        
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
        if (amount && amount > 0) {
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
    
    try {
      if (usePreAuth) {
        // FIXED: Create a setup session for pre-authorization with detailed logging
        console.log('Creating pre-authorization setup session with metadata:', metadata);
        
        const setupSessionData = {
          payment_method_types: ['card'],
          mode: 'setup',
          setup_intent_data: {
            metadata
            // Removed 'usage' parameter as it's not supported in setup_intent_data
          },
          success_url: successUrl + `?session_id={CHECKOUT_SESSION_ID}&type=preauth&amount=${stripeAmount / 100}&payment_type=${paymentType}`,
          cancel_url: cancelUrl,
          metadata
        };
        
        // Add customer email if available
        if (jobDetails.jobData.customerEmail) {
          setupSessionData.customer_email = jobDetails.jobData.customerEmail;
        }
        
        console.log('Setup session data:', JSON.stringify(setupSessionData, null, 2));
        
        session = await stripe.checkout.sessions.create(setupSessionData);
      } else {
        // FIXED: Create a regular payment session
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
      
    } catch (stripeError) {
      console.error('Stripe API error:', stripeError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to create Stripe session', 
          details: stripeError.message,
          stripeCode: stripeError.code
        })
      };
    }
    
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
