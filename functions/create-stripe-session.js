// create-stripe-session.js - Creates Stripe payment or pre-auth sessions
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Parse the request body
    const data = JSON.parse(event.body);
    const { jobId, paymentType, amount, successUrl, cancelUrl } = data;
    
    if (!jobId || !paymentType || !successUrl || !cancelUrl) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required parameters: jobId, paymentType, successUrl, cancelUrl' })
      };
    }
    
    // Get job details using our new API
    const baseUrl = process.env.URL || `https://${event.headers.host}`;
    const jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    
    const jobResponse = await fetch(jobDetailsUrl);
    const jobDetails = await jobResponse.json();
    
    if (!jobResponse.ok || !jobDetails.success) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to fetch job details', details: jobDetails.error })
      };
    }
    
    // Helper function to check if pre-auth timing is valid for excess payments
    function getExcessPaymentInfo(jobDetails) {
      const now = new Date();
      const hireStart = new Date(jobDetails.jobData.startDate);
      const hireEnd = new Date(jobDetails.jobData.endDate);
      const hireDays = jobDetails.jobData.hireDays;
      
      // For hires of 4 days or less, we MUST use pre-auth to save fees
      if (hireDays <= 4) {
        // Calculate earliest date we can take pre-auth
        // (hire end + 1 buffer day - 5 max hold days)
        const earliestPreAuthDate = new Date(hireEnd);
        earliestPreAuthDate.setDate(earliestPreAuthDate.getDate() + 1 - 5); // +1 buffer, -5 max hold
        
        if (now < earliestPreAuthDate) {
          // Too early for pre-auth
          return {
            canPayNow: false,
            mustUsePreAuth: true,
            earliestPaymentDate: earliestPreAuthDate,
            message: `For short hires, we use pre-authorization to reduce fees. Please return on ${earliestPreAuthDate.toDateString()} or later to complete the insurance excess.`
          };
        } else if (now <= hireEnd) {
          // Perfect timing for pre-auth
          return {
            canPayNow: true,
            mustUsePreAuth: true,
            usePreAuth: true,
            message: 'Insurance excess will be pre-authorized (held but not charged unless needed)'
          };
        } else {
          // Hire has ended, too late for pre-auth
          return {
            canPayNow: true,
            mustUsePreAuth: false,
            usePreAuth: false,
            message: 'Hire has ended. Insurance excess will be charged as a regular payment.'
          };
        }
      } else {
        // Long hire - always use regular payment
        return {
          canPayNow: true,
          mustUsePreAuth: false,
          usePreAuth: false,
          message: 'Insurance excess will be charged as a regular payment (refundable after hire)'
        };
      }
    }
    
    // Determine payment details based on type
    let stripeAmount = 0;
    let description = '';
    let usePreAuth = false;
    let currency = jobDetails.financial.currency.toLowerCase();
    let statusMessage = '';
    
    switch (paymentType) {
      case 'deposit':
        if (jobDetails.financial.depositPaid) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Deposit already paid' })
          };
        }
        stripeAmount = Math.round(jobDetails.financial.requiredDeposit * 100); // Convert to pence
        description = `Deposit for job #${jobId} - ${jobDetails.jobData.jobName}`;
        statusMessage = 'Paying this deposit will secure your booking and change the status to "Booked"';
        // Hire payments are ALWAYS regular payments, never pre-auth
        usePreAuth = false;
        break;
        
      case 'balance':
        if (jobDetails.financial.fullyPaid) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Job already fully paid' })
          };
        }
        stripeAmount = Math.round(Math.max(0, jobDetails.financial.remainingHireBalance) * 100); // Convert to pence
        description = `Balance payment for job #${jobId} - ${jobDetails.jobData.jobName}`;
        statusMessage = 'This will complete your hire payment';
        // Hire payments are ALWAYS regular payments, never pre-auth
        usePreAuth = false;
        break;
        
      case 'excess':
        // Get excess payment rules based on hire length and timing
        const excessInfo = getExcessPaymentInfo(jobDetails);
        
        if (!excessInfo.canPayNow) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: 'Cannot process excess payment at this time',
              message: excessInfo.message,
              earliestPaymentDate: excessInfo.earliestPaymentDate
            })
          };
        }
        
        usePreAuth = excessInfo.usePreAuth;
        statusMessage = excessInfo.message;
        
        if (usePreAuth) {
          description = `Insurance excess pre-authorization for job #${jobId} - ${jobDetails.jobData.jobName}`;
        } else {
          description = `Insurance excess payment for job #${jobId} - ${jobDetails.jobData.jobName}`;
        }
        
        // Use provided amount or default to remaining excess needed
        if (amount) {
          stripeAmount = Math.round(amount * 100);
        } else {
          const excessNeeded = Math.max(0, 1200 - jobDetails.financial.excessPaid);
          stripeAmount = Math.round(excessNeeded * 100);
        }
        break;
        
      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid payment type. Must be: deposit, balance, or excess' })
        };
    }
    
    if (stripeAmount <= 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Payment amount must be greater than zero' })
      };
    }
    
    // Create metadata for the session
    const metadata = {
      jobId: jobId.toString(),
      paymentType,
      isPreAuth: usePreAuth.toString(),
      customerName: jobDetails.jobData.rawJobData.NAME || '',
      customerEmail: jobDetails.jobData.rawJobData.EMAIL || '',
      hireDays: jobDetails.jobData.hireDays?.toString() || '',
      jobName: jobDetails.jobData.jobName || ''
    };
    
    let session;
    
    if (usePreAuth) {
      // Create a setup session for pre-authorization
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'setup',
        setup_intent_data: {
          metadata,
          usage: 'off_session' // Allows us to charge later without customer present
        },
        success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}&type=preauth',
        cancel_url: cancelUrl,
        customer_email: jobDetails.jobData.rawJobData.EMAIL,
        metadata
      });
    } else {
      // Create a regular payment session
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
        success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}&type=payment',
        cancel_url: cancelUrl,
        customer_email: jobDetails.jobData.rawJobData.EMAIL,
        metadata
      });
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
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
          customerName: jobDetails.jobData.rawJobData.NAME,
          hireDays: jobDetails.jobData.hireDays,
          dates: `${jobDetails.jobData.startDate} to ${jobDetails.jobData.endDate}`
        }
      })
    };
    
  } catch (error) {
    console.error('Error creating Stripe session:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
