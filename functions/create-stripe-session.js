// create-stripe-session.js - FIXED: Minimal address collection + working return URLs
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
    
    console.log(`🎯 Creating Stripe session - jobId=${jobId}, paymentType=${paymentType}, userAmount=£${amount}`);
    
    if (!jobId || !paymentType) {
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
        // 🎯 SIMPLIFIED LOGIC: Use the amount from frontend directly
        if (amount && amount > 0) {
          stripeAmount = Math.round(amount * 100);
          description = `Deposit for job #${jobId}`;
          console.log(`💰 Using frontend amount: £${amount} (${stripeAmount} pence)`);
        } else {
          // Fallback if no amount provided - shouldn't happen with your UI
          const remainingBalance = Math.max(0, jobDetails.financial.actualTotalOwed - jobDetails.financial.totalHirePaid);
          stripeAmount = Math.round(remainingBalance * 100);
          description = `Payment for job #${jobId}`;
          console.log(`⚠️ No amount provided, using remaining balance: £${remainingBalance}`);
        }
        break;
        
      case 'balance':
        // For balance payments, use amount if provided, otherwise calculate fresh balance
        if (amount && amount > 0) {
          stripeAmount = Math.round(amount * 100);
          console.log(`💰 Using frontend balance amount: £${amount}`);
        } else {
          const freshRemainingBalance = Math.max(0, jobDetails.financial.remainingHireBalance);
          stripeAmount = Math.round(freshRemainingBalance * 100);
          console.log(`💰 Using calculated balance: £${freshRemainingBalance}`);
        }
        description = `Balance payment for job #${jobId}`;
        break;
        
      case 'excess':
        // Pre-auth logic unchanged
        if (jobDetails.excess.method === 'pre-auth' && jobDetails.excess.canPreAuth) {
          usePreAuth = true;
          description = `Insurance excess pre-auth for job #${jobId}`;
        } else {
          description = `Insurance excess payment for job #${jobId}`;
        }
        
        // Use amount if provided, otherwise calculate fresh excess needed
        if (amount && amount > 0) {
          stripeAmount = Math.round(amount * 100);
          console.log(`💰 Using frontend excess amount: £${amount}`);
        } else {
          const freshExcessNeeded = Math.max(0, jobDetails.excess.amount - jobDetails.financial.excessPaid);
          stripeAmount = Math.round(freshExcessNeeded * 100);
          console.log(`💰 Using calculated excess: £${freshExcessNeeded}`);
        }
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
    
    // 🔧 FIXED: Use working URL pattern with proper return URLs
    const deployUrl = 'https://ooosh-tours-payment-page.netlify.app';
    
    // Get the hash (reuse from job details)
    const jobHash = jobDetails.hash || jobDetails.debug?.generatedHash;
    
    // 🎯 FIXED: Proper return URLs that come back to your payment page
    const fixedSuccessUrl = `${deployUrl}/payment.html?jobId=${jobId}&hash=${jobHash}&success=true&session_id={CHECKOUT_SESSION_ID}&amount=${stripeAmount/100}&type=${paymentType}`;
    const fixedCancelUrl = `${deployUrl}/payment.html?jobId=${jobId}&hash=${jobHash}&cancelled=true`;
    
    console.log(`🔧 Return URLs configured:`);
    console.log(`   Success: ${fixedSuccessUrl.substring(0, 100)}...`);
    console.log(`   Cancel: ${fixedCancelUrl.substring(0, 100)}...`);
    
    // Validate URL lengths (Stripe limit is 5000 characters)
    if (fixedSuccessUrl.length >= 5000 || fixedCancelUrl.length >= 5000) {
      console.error(`❌ URL too long! Success: ${fixedSuccessUrl.length}, Cancel: ${fixedCancelUrl.length}`);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Internal URL configuration error',
          details: 'Generated URLs exceed Stripe limits'
        })
      };
    }
    
    let session;
    
    try {
      if (usePreAuth) {
        console.log('🔐 Creating pre-authorization session');
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'setup',
          setup_intent_data: { metadata },
          success_url: fixedSuccessUrl,
          cancel_url: fixedCancelUrl,
          metadata,
          customer_creation: 'if_required',
          billing_address_collection: 'auto' // 🔧 FIXED: Only postcode, not full address
        });
      } else {
        console.log('💳 Creating payment session');
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
          success_url: fixedSuccessUrl,
          cancel_url: fixedCancelUrl,
          metadata,
          customer_creation: 'if_required',
          billing_address_collection: 'auto' // 🔧 FIXED: Only postcode, not full address
        });
      }
      
      console.log(`✅ Stripe session created: ${session.id} for £${stripeAmount/100}`);
      console.log(`🔗 Session URL: ${session.url}`);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          sessionId: session.id, 
          url: session.url,
          amount: stripeAmount / 100,
          returnUrl: fixedSuccessUrl.replace('{CHECKOUT_SESSION_ID}', session.id)
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
