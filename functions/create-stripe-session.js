// create-stripe-session.js - UPDATED: Manual capture for true pre-authorizations
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
        // 🔧 UPDATED: Pre-auth now means manual capture payment
        if (jobDetails.excess.method === 'pre-auth' && jobDetails.excess.canPreAuth) {
          usePreAuth = true;
          // 🔧 UPDATED: Better description for customer's bank statement
          description = `OOOSH EXCESS HOLD - Job #${jobId}`;
          console.log(`🔐 EXCESS PRE-AUTH: Will create manual capture payment intent to HOLD funds`);
        } else {
          description = `Insurance excess payment for job #${jobId}`;
          console.log(`💳 EXCESS PAYMENT: Regular payment (not pre-auth)`);
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
    
    // 🎯 FIXED: Clean return URLs that go back to the payment homepage
    const deployUrl = 'https://ooosh-tours-payment-page.netlify.app';
    
    // Get the hash (reuse from job details)
    const jobHash = jobDetails.hash || jobDetails.debug?.generatedHash;
    
    // ✅ FIXED: Clean URLs that return to the payment homepage with a success indicator
    const cleanSuccessUrl = `${deployUrl}/payment.html?jobId=${jobId}&hash=${jobHash}&payment_success=true`;
    const cleanCancelUrl = `${deployUrl}/payment.html?jobId=${jobId}&hash=${jobHash}&payment_cancelled=true`;
    
    console.log(`🔧 Clean return URLs configured:`);
    console.log(`   Success: ${cleanSuccessUrl}`);
    console.log(`   Cancel: ${cleanCancelUrl}`);
    
    // Validate URL lengths (Stripe limit is 5000 characters)
    if (cleanSuccessUrl.length >= 5000 || cleanCancelUrl.length >= 5000) {
      console.error(`❌ URL too long! Success: ${cleanSuccessUrl.length}, Cancel: ${cleanCancelUrl.length}`);
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
        // 🔧 COMPLETELY REWRITTEN: True pre-authorization with manual capture
        console.log('🔐 Creating TRUE pre-authorization with MANUAL CAPTURE');
        console.log(`   - Amount to HOLD on card: £${stripeAmount/100}`);
        console.log(`   - This will show as PENDING on customer's statement`);
        console.log(`   - Funds will be FROZEN and can be captured without authentication`);
        console.log(`   - Authorization valid for 7 days`);
        
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'gbp',
              product_data: {
                name: `Insurance Excess Pre-Authorization`,
                description: `Refundable excess for job #${jobId} - Amount will be held on your card for up to 7 days`,
                metadata
              },
              unit_amount: stripeAmount,
            },
            quantity: 1,
          }],
          mode: 'payment', // 🔧 CHANGED: Now using payment mode, not setup mode
          payment_intent_data: {
            capture_method: 'manual', // 🔧 KEY CHANGE: Manual capture for true pre-auth
            statement_descriptor_suffix: `JOB${jobId}`, // Shows on bank statement
            metadata: {
              ...metadata,
              captureMethod: 'manual',
              maxCaptureWindow: '7_days'
            },
            description: `Pre-auth excess hold for job #${jobId} - Funds frozen for up to 7 days`,
            receipt_email: jobDetails.jobData?.customerEmail || null
          },
          success_url: cleanSuccessUrl,
          cancel_url: cleanCancelUrl,
          metadata,
          customer_creation: 'always', // 🔧 IMPORTANT: Always create customer for pre-auths
          customer_email: jobDetails.jobData?.customerEmail || null,
          billing_address_collection: 'auto',
          // 🔧 NEW: Add clear messaging for customers
          submit_type: 'pay',
          consent_collection: {
            terms_of_service: 'required',
          },
          custom_text: {
            submit: {
              message: `By authorizing this payment, you agree to a hold of £${(stripeAmount/100).toFixed(2)} on your card for up to 7 days. This amount will only be charged if there are damages or additional costs.`
            }
          }
        });
        
        console.log(`✅ PRE-AUTH SESSION CREATED: ${session.id}`);
        console.log(`   - Payment Intent will be created on completion`);
        console.log(`   - Customer will see "PENDING" charge immediately`);
        console.log(`   - Admin can capture without customer authentication`);
        
      } else {
        // Regular payment - unchanged
        console.log('💳 Creating regular payment session (immediate capture)');
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
          success_url: cleanSuccessUrl,
          cancel_url: cleanCancelUrl,
          metadata,
          customer_creation: 'if_required',
          billing_address_collection: 'auto'
        });
        
        console.log(`✅ Regular payment session created: ${session.id}`);
      }
      
      console.log(`✅ Stripe session created: ${session.id} for £${stripeAmount/100}`);
      console.log(`🔗 Session URL: ${session.url}`);
      
      // 🔧 NEW: Enhanced response with pre-auth info
      const responseData = {
        sessionId: session.id,
        url: session.url,
        amount: stripeAmount / 100,
        returnUrl: cleanSuccessUrl,
        isPreAuth: usePreAuth,
        preAuthInfo: usePreAuth ? {
          type: 'manual_capture',
          holdAmount: stripeAmount / 100,
          validForDays: 7,
          message: 'Funds will be held on card immediately and can be captured without further authentication'
        } : null
      };
      
      console.log('📤 Returning response:', JSON.stringify(responseData, null, 2));
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(responseData)
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
