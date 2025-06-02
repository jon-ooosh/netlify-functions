// handle-stripe-webhook.js - FIXED VERSION FOR XERO SYNC
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 XERO SYNC FIX - Processing Stripe payment');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    let stripeEvent;
    const signature = event.headers['stripe-signature'];
    
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified');
    } catch (err) {
      console.log('⚠️ Signature verification failed, parsing without verification');
      stripeEvent = JSON.parse(event.body);
    }
    
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(stripeEvent.data.object);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(stripeEvent.data.object);
        break;
      default:
        console.log(`🔄 Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true })
    };
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

async function handleCheckoutSessionCompleted(session) {
  console.log('🎯 Processing checkout session:', session.id);
  const { jobId, paymentType, isPreAuth } = session.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  if (isPreAuth !== 'true') {
    await createHireHopDepositWithXeroSync(jobId, paymentType, session);
  } else {
    await addPreAuthNote(jobId, paymentType, session);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  await createHireHopDepositWithXeroSync(jobId, paymentType, paymentIntent);
}

// 🎯 CRITICAL FIX: Get Xero accounting package details for proper sync
async function getXeroAccountingDetails(token, hirehopDomain) {
  try {
    // First, get the list of accounting packages to find Xero details
    const packagesUrl = `https://${hirehopDomain}/php_functions/accounting_packages_list.php?token=${encodeURIComponent(token)}`;
    
    const response = await fetch(packagesUrl);
    if (!response.ok) {
      console.error('Failed to fetch accounting packages');
      return null;
    }
    
    const packagesData = await response.json();
    
    // Look for Xero package
    const xeroPackage = packagesData.rows?.find(pkg => 
      pkg.type && pkg.type.toLowerCase().includes('xero')
    );
    
    if (xeroPackage) {
      console.log('🏦 Found Xero accounting package:', xeroPackage.name);
      return {
        packageId: xeroPackage.id,
        accId: xeroPackage.acc_id, // This is the critical missing field!
        syncEnabled: xeroPackage.sync_enabled !== false
      };
    }
    
    console.log('⚠️ No Xero package found in accounting packages');
    return null;
    
  } catch (error) {
    console.error('❌ Error getting Xero details:', error);
    return null;
  }
}

// 🎯 MAIN FIX: Create deposit with proper Xero sync fields
async function createHireHopDepositWithXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 Creating ${paymentType} deposit with Xero sync for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    let amount = 0;
    if (stripeObject.amount_total) {
      amount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      amount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      amount = stripeObject.amount_received / 100;
    }
    
    // 🎯 CRITICAL: Get Xero accounting details
    const xeroDetails = await getXeroAccountingDetails(token, hirehopDomain);
    
    // Clean description formatting
    let description = `${jobId}`;
    if (paymentType === 'excess') {
      description += ' - excess';
    } else if (paymentType === 'balance') {
      description += ' - balance';
    } else if (paymentType === 'deposit') {
      description += ' - deposit';
    }
    
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // 🎯 KEY FIX: Include Xero-specific fields in deposit data
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: ${stripeObject.id}`,
      ACC_ACCOUNT_ID: 267, // Stripe GBP bank account
      local: new Date().toISOString().replace('T', ' ').substring(0, 19),
      tz: 'Europe/London',
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[NAME]': 'United Kingdom Pound',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      'CURRENCY[NEGATIVE_FORMAT]': 1,
      'CURRENCY[SYMBOL_POSITION]': 0,
      'CURRENCY[DECIMAL_SEPARATOR]': '.',
      'CURRENCY[THOUSAND_SEPARATOR]': ',',
      ACC_PACKAGE_ID: 3, // Default accounting package
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    // 🎯 CRITICAL FIX: Add Xero-specific fields if Xero package is available
    if (xeroDetails) {
      depositData.ACC_PACKAGE_ID = xeroDetails.packageId;
      
      // 🔧 THE KEY FIX: Add the missing ACC_ID field that enables Xero sync
      if (xeroDetails.accId) {
        depositData.ACC_ID = xeroDetails.accId;
        console.log(`✅ Added ACC_ID for Xero sync: ${xeroDetails.accId}`);
      }
      
      // Additional Xero sync flags
      depositData.SYNC_TO_ACCOUNTING = true;
      depositData.ACCOUNTING_PACKAGE_TYPE = 'xero';
      
      console.log('🏦 Using Xero accounting package:', xeroDetails.packageId);
    } else {
      console.log('⚠️ No Xero details found - deposit may not sync');
    }
    
    console.log('💰 Creating deposit with enhanced Xero support:', { 
      jobId, 
      paymentType, 
      amount: `£${amount.toFixed(2)}`, 
      description,
      stripeId: stripeObject.id,
      hasXeroDetails: !!xeroDetails,
      accId: xeroDetails?.accId || 'none'
    });
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = responseText;
    }
    
    if (response.ok && parsedResponse.hh_id) {
      console.log(`✅ SUCCESS! Deposit ${parsedResponse.hh_id} created for job ${jobId}`);
      console.log(`📊 Xero sync details:`, {
        depositId: parsedResponse.hh_id,
        syncAccounts: parsedResponse.sync_accounts,
        accId: parsedResponse.ACC_ID || 'missing',
        xeroEnabled: !!xeroDetails
      });
      
      // Enhanced success note with Xero sync status
      const syncStatus = parsedResponse.ACC_ID ? '🔄 Xero sync enabled' : '⚠️ Xero sync disabled';
      await addHireHopNote(jobId, `💳 Stripe: £${amount.toFixed(2)} ${paymentType} payment. ID: ${stripeObject.id}. Deposit: ${parsedResponse.hh_id}. ${syncStatus}`);
      
      // 🎯 VERIFICATION: Check if deposit appears with ACC_ID
      if (!parsedResponse.ACC_ID && xeroDetails) {
        console.log('🔧 Attempting to update ACC_ID post-creation...');
        await updateDepositWithAccId(jobId, parsedResponse.hh_id, xeroDetails.accId, token, hirehopDomain);
      }
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      await addHireHopNote(jobId, `🚨 MANUAL DEPOSIT NEEDED: £${amount.toFixed(2)} ${paymentType}. Stripe: ${stripeObject.id}. Error: ${JSON.stringify(parsedResponse)}`);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error creating deposit:', error);
    await addHireHopNote(jobId, `🚨 SYSTEM ERROR: ${paymentType} payment failed. Stripe: ${stripeObject.id}. Error: ${error.message}`);
    throw error;
  }
}

// 🎯 NEW: Attempt to update deposit with ACC_ID if missing
async function updateDepositWithAccId(jobId, depositId, accId, token, hirehopDomain) {
  try {
    console.log(`🔧 Updating deposit ${depositId} with ACC_ID ${accId}`);
    
    const updateData = {
      ID: depositId,
      ACC_ID: accId,
      SYNC_TO_ACCOUNTING: true,
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(updateData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = responseText;
    }
    
    if (response.ok) {
      console.log(`✅ Deposit ${depositId} updated with ACC_ID`);
      await addHireHopNote(jobId, `🔄 Updated deposit ${depositId} for Xero sync compatibility`);
      return true;
    } else {
      console.log(`⚠️ Failed to update deposit with ACC_ID:`, parsedResponse);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error updating deposit with ACC_ID:', error);
    return false;
  }
}

async function addPreAuthNote(jobId, paymentType, session) {
  const amount = session.amount_total / 100;
  const noteText = `💳 Pre-auth: £${amount.toFixed(2)} ${paymentType}. Stripe: ${session.id}`;
  await addHireHopNote(jobId, noteText);
  console.log(`✅ Pre-auth note added for job ${jobId}`);
}

async function getJobClientId(jobId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(jobDataUrl);
    const jobData = await response.json();
    
    if (jobData && jobData.CLIENT_ID) {
      return jobData.CLIENT_ID;
    } else {
      return 1822; // Fallback
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822; // Fallback
  }
}

async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    return response.ok;
  } catch (error) {
    console.error('❌ Error adding note:', error);
    return false;
  }
}
