// create-stripe-session.js - FIXED VERSION WITH FRESH BALANCE CALCULATION
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
    
    const { jobId, paymentType, successUrl, cancelUrl } = data;
    
    console.log(`🎯 BALANCE FIX: Stripe session request - jobId=${jobId}, paymentType=${paymentType}`);
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters: jobId, paymentType, successUrl, cancelUrl' })
      };
    }
    
    // 🎯 KEY FIX: ALWAYS get fresh job details with current balance calculation
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || `https://${event.headers.host}`;
    console.log('🔄 GETTING FRESH BALANCE: Base URL for API calls:', baseUrl);
    
    // First call to get the hash
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    console.log('🔄 GETTING FRESH BALANCE: Making initial job details request to:', jobDetailsUrl);
    
    let jobResponse;
    try {
      jobResponse = await fetch(jobDetailsUrl);
      console.log('🔄 GETTING FRESH BALANCE: Initial job response status:', jobResponse.status);
    } catch (fetchError) {
      console.error('❌ Failed to fetch job details:', fetchError);
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
        console.log('🔄 GETTING FRESH BALANCE: Job details response:', { success: jobDetails.success, authenticated: jobDetails.authenticated, hasHash: !!jobDetails.hash });
      } catch (jsonError) {
        console.error('❌ Failed to parse job details JSON:', jsonError);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Invalid response from job details API', details: jsonError.message })
        };
      }
      
      // If we get a hash response (no hash provided), we need to call again with hash
      if (jobDetails.hash && !jobDetails.authenticated) {
        jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${jobDetails.hash}`;
        console.log('🔄 GETTING FRESH BALANCE: Making authenticated job details request to:', jobDetailsUrl);
        
        try {
          const jobResponse2 = await fetch(jobDetailsUrl);
          console.log('🔄 GETTING FRESH BALANCE: Authenticated job response status:', jobResponse2.status);
          
          if (!jobResponse2.ok) {
            const errorText = await jobResponse2.text();
            console.error('❌ Authenticated job details failed:', errorText);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to fetch authenticated job details', details: errorText })
            };
          }
          
          jobDetails = await jobResponse2.json();
          console.log('✅ FRESH BALANCE LOADED: Authenticated job details received:', { success: jobDetails.success });
        } catch (fetchError2) {
          console.error('❌ Failed to fetch authenticated job details:', fetchError2);
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
        console.error('❌ Job details API error:', errorData);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Failed to fetch job details', details: errorData.error || 'Unknown error' })
        };
      } catch (jsonError) {
        const errorText = await jobResponse.text();
        console.error('❌ Job details API error (raw):', errorText);
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
    
    console.log(`✅ FRESH BALANCE LOADED: Job details retrieved successfully. Excess method: ${jobDetails.excess?.method || 'N/A'}`);
    
    // 🎯 KEY FIX: Use fresh amounts from get-job-details-v2, NOT stale amounts from request
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
        // 🎯 BALANCE FIX: Use fresh deposit amount
        stripeAmount = Math.round(jobDetails.financial.requiredDeposit * 100);
        description = `Deposit for job #${jobId} - ${jobDetails.jobData.customerName}`;
        statusMessage = 'Paying this deposit will secure your booking and change the status to "Booked"';
        usePreAuth = false;
        console.log(`💰 FRESH DEPOSIT AMOUNT: £${jobDetails.financial.requiredDeposit} = ${stripeAmount} pence`);
        break;
        
      case 'balance':
        if (jobDetails.financial.fullyPaid) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Job already fully paid' })
          };
        }
        // 🎯 BALANCE FIX: Use fresh remaining balance (this was the main issue!)
        const freshRemainingBalance = Math.max(0, jobDetails.financial.remainingHireBalance);
        stripeAmount = Math.round(freshRemainingBalance * 100);
        description = `Balance payment for job #${jobId} - ${jobDetails.jobData.customerName}`;
        statusMessage = 'This will complete your hire payment';
        usePreAuth = false;
        console.log(`💰 FRESH BALANCE AMOUNT: £${freshRemainingBalance} = ${stripeAmount} pence (was showing wrong amount before)`);
        break;
        
      case 'excess':
        console.log(`🚗 Excess payment - method: ${jobDetails.excess.method}, canPreAuth: ${jobDetails.excess.canPreAuth}`);
        
        if (jobDetails.excess.method === 'pre-auth' && jobDetails.excess.canPreAuth) {
          usePreAuth = true;
          description = `Insurance excess pre-authorization for job #${jobId} - ${jobDetails.jobData.customerName}`;
          statusMessage = 'Pre-authorization will be held but not charged unless needed';
        } else if (jobDetails.excess.method === 'payment' || jobDetails.excess.method === 'too_late') {
          usePreAuth = false;
          description = `Insurance excess payment for job #${jobId} - ${jobDetails.jobData.customerName}`;
          statusMessage = 'Payment will be charged and refunded after hire if unused';
        } else {
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
        
        // 🎯 BALANCE FIX: Use fresh excess amount
        const freshExcessNeeded = Math.max(0, jobDetails.excess.amount - jobDetails.financial.excessPaid);
        stripeAmount = Math.round(freshExcessNeeded * 100);
        console.log(`💰 FRESH EXCESS AMOUNT: £${freshExcessNeeded} = ${stripeAmount} pence`);
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
    
    console.log(`✅ BALANCE FIX COMPLETE: Creating Stripe session with FRESH amount=${stripeAmount} pence (£${(stripeAmount/100).toFixed(2)}), usePreAuth=${usePreAuth}`);
    
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
        console.log('🔐 Creating pre-authorization setup session with metadata:', metadata);
        
        const setupSessionData = {
          payment_method_types: ['card'],
          mode: 'setup',
          setup_intent_data: {
            metadata
          },
          success_url: successUrl + `?session_id={CHECKOUT_SESSION_ID}&type=preauth&amount=${stripeAmount / 100}&payment_type=${paymentType}`,
          cancel_url: cancelUrl,
          metadata
        };
        
        if (jobDetails.jobData.customerEmail) {
          setupSessionData.customer_email = jobDetails.jobData.customerEmail;
        }
        
        console.log('🔐 Setup session data:', JSON.stringify(setupSessionData, null, 2));
        session = await stripe.checkout.sessions.create(setupSessionData);
      } else {
        console.log('💳 Creating regular payment session');
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
      
      console.log(`🎉 BALANCE FIX SUCCESS: Stripe session created successfully: ${session.id} with CORRECT amount £${(stripeAmount/100).toFixed(2)}`);
      
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
          },
          // 🎯 DEBUG INFO: Include balance calculation for verification
          debug: {
            freshBalanceUsed: true,
            totalOwed: jobDetails.financial.actualTotalOwed,
            alreadyPaid: jobDetails.financial.totalHirePaid,
            calculatedBalance: jobDetails.financial.remainingHireBalance,
            stripeAmountPence: stripeAmount,
            stripeAmountPounds: stripeAmount / 100
          }
        })
      };
      
    } catch (stripeError) {
      console.error('❌ Stripe API error:', stripeError);
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
    console.error('❌ Error creating Stripe session:', error);
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
