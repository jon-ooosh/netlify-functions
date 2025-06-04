// create-stripe-session.js - ULTRA-SHORT URLs to fix 5000 char limit
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
    let data;
    try {
      data = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
      };
    }
    
    const { jobId, paymentType, amount, successUrl, cancelUrl } = data;
    
    console.log(`🎯 Creating Stripe session - jobId=${jobId}, paymentType=${paymentType}`);
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }
    
    // Get fresh job details
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || `https://${event.headers.host}`;
    
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    let jobResponse = await fetch(jobDetailsUrl);
    let jobDetails = await jobResponse.json();
    
    if (jobDetails.hash && !jobDetails.authenticated) {
      jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${jobDetails.hash}`;
      const jobResponse2 = await fetch(jobDetailsUrl);
      jobDetails = await jobResponse2.json();
    }
    
    if (!jobDetails.success) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch job details' })
      };
    }
    
    // Calculate payment amount
    let stripeAmount = 0;
    let description = '';
    let usePreAuth = false;
    let currency = 'gbp';
    
    switch (paymentType) {
      case 'deposit':
        const totalOwed = jobDetails.financial.actualTotalOwed;
        const alreadyPaid = jobDetails.financial.totalHirePaid;
        const remainingBalance = Math.max(0, totalOwed - alreadyPaid);
        
        const isUnder400 = totalOwed < 400;
        const hireDays = jobDetails.jobData.hireDays || 1;
        const requiresFullPayment = isUnder400 || hireDays <= 1;
        
        if (requiresFullPayment) {
          stripeAmount = Math.round(remainingBalance * 100);
          description = `Full payment for job #${jobId}`;
        } else {
          let depositAmount;
          if (amount && amount > 0) {
            depositAmount = Math.min(amount, remainingBalance);
          } else {
            depositAmount = Math.min(jobDetails.financial.requiredDeposit, remainingBalance);
          }
          stripeAmount = Math.round(depositAmount * 100);
          description = `Deposit for job #${jobId}`;
        }
        break;
        
      case 'balance':
        const freshRemainingBalance = Math.max(0, jobDetails.financial.remainingHireBalance);
        stripeAmount = Math.round(freshRemainingBalance * 100);
        description = `Balance payment for job #${jobId}`;
        break;
        
      case 'excess':
        if (jobDetails.excess.method === 'pre-auth' && jobDetails.excess.canPreAuth) {
          usePreAuth = true;
          description = `Insurance excess pre-auth for job #${jobId}`;
        } else {
          description = `Insurance excess payment for job #${jobId}`;
        }
        
        const freshExcessNeeded = Math.max(0, jobDetails.excess.amount - jobDetails.financial.excessPaid);
        stripeAmount = Math.round(freshExcessNeeded * 100);
        break;
        
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid payment type' })
        };
    }
    
    if (stripeAmount <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Payment amount must be greater than zero' })
      };
    }
    
    // Create metadata
    const metadata = {
      jobId: jobId.toString(),
      paymentType,
      isPreAuth: usePreAuth.toString()
    };
    
    // 🔧 ULTRA-SHORT URLs - just the basics!
    const ultraShortSuccessUrl = successUrl + `?ok=1`;
    const ultraShortCancelUrl = cancelUrl;
    
    console.log(`🔧 ULTRA-SHORT URLs - Success: ${ultraShortSuccessUrl.length} chars, Cancel: ${ultraShortCancelUrl.length} chars`);
    
    let session;
    
    try {
      if (usePreAuth) {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'setup',
          setup_intent_data: { metadata },
          success_url: ultraShortSuccessUrl,
          cancel_url: ultraShortCancelUrl,
          metadata
        });
      } else {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency,
              product_data: {
                name: description,
                metadata
              },
              unit_amount: stripeAmount,
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: ultraShortSuccessUrl,
          cancel_url: ultraShortCancelUrl,
          metadata
        });
      }
      
      console.log(`✅ Stripe session created: ${session.id}`);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          sessionId: session.id, 
          url: session.url,
          amount: stripeAmount / 100
        })
      };
      
    } catch (stripeError) {
      console.error('❌ Stripe API error:', stripeError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to create Stripe session', 
          details: stripeError.message
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
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
