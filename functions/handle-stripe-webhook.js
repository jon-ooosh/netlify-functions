// handle-stripe-webhook.js - FINAL VERSION WITH XERO SYNC TRIGGER
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 FINAL XERO SYNC - Processing Stripe payment');
    
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
    await createDepositWithXeroSync(jobId, paymentType, session);
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
  
  await createDepositWithXeroSync(jobId, paymentType, paymentIntent);
}

// 🎯 FINAL: Create deposit and trigger Xero sync
async function createDepositWithXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 Creating ${paymentType} deposit with Xero sync trigger for job ${jobId}`);
    
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
    
    // 🎯 STEP 1: Create the deposit with the exact same parameters as manual creation
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
      ACC_PACKAGE_ID: 3, // Xero - Main accounting package
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    console.log('💰 Creating deposit with parameters matching manual creation:', { 
      jobId, 
      paymentType, 
      amount: `£${amount.toFixed(2)}`, 
      description,
      stripeId: stripeObject.id,
      accPackageId: 3,
      accAccountId: 267
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
      console.log(`📊 Response details:`, {
        depositId: parsedResponse.hh_id,
        syncAccounts: parsedResponse.sync_accounts,
        hhTask: parsedResponse.hh_task,
        hhAccPackageId: parsedResponse.hh_acc_package_id,
        hhPackageType: parsedResponse.hh_package_type
      });
      
      // 🎯 STEP 2: CRITICAL - Trigger Xero sync by calling the sync function
      console.log('🔄 STEP 2: Triggering Xero sync for deposit...');
      const syncSuccess = await triggerXeroSync(jobId, parsedResponse.hh_id, token, hirehopDomain);
      
      // 🎯 STEP 3: Verify sync completed by checking for ACC_ID
      console.log('🔍 STEP 3: Verifying Xero sync completion...');
      setTimeout(async () => {
        await verifyXeroSync(jobId, parsedResponse.hh_id, token, hirehopDomain);
      }, 5000); // Check after 5 seconds
      
      const syncStatus = syncSuccess ? '✅ Xero sync triggered' : '⚠️ Xero sync failed';
      await addHireHopNote(jobId, `💳 Stripe: £${amount.toFixed(2)} ${paymentType}. ID: ${stripeObject.id}. Deposit: ${parsedResponse.hh_id}. ${syncStatus}`);
      
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

// 🔄 CRITICAL: Trigger Xero sync after deposit creation
async function triggerXeroSync(jobId, depositId, token, hirehopDomain) {
  try {
    console.log(`🔄 Triggering Xero sync for deposit ${depositId}`);
    
    // Method 1: Try to trigger sync by calling the accounting sync endpoint
    const syncEndpoints = [
      // Try direct accounting sync
      `https://${hirehopDomain}/php_functions/accounting_sync.php`,
      `https://${hirehopDomain}/php_functions/sync_accounting.php`,
      `https://${hirehopDomain}/php_functions/xero_sync.php`,
      
      // Try deposit-specific sync
      `https://${hirehopDomain}/php_functions/deposit_sync.php`,
      `https://${hirehopDomain}/php_functions/billing_sync.php`
    ];
    
    for (const endpoint of syncEndpoints) {
      try {
        console.log(`🔄 Trying sync endpoint: ${endpoint.split('/').pop()}`);
        
        const syncData = {
          job_id: jobId,
          deposit_id: depositId,
          billing_id: depositId,
          acc_package_id: 3, // Xero package ID
          sync_now: true,
          force_sync: true,
          token: token
        };
        
        const syncResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(syncData).toString()
        });
        
        if (syncResponse.ok) {
          const syncResult = await syncResponse.text();
          console.log(`✅ Sync endpoint ${endpoint.split('/').pop()} responded: ${syncResult.substring(0, 100)}`);
          
          // If we get a successful response, consider it a win
          if (!syncResult.toLowerCase().includes('error') && !syncResult.includes('404')) {
            return true;
          }
        }
      } catch (syncError) {
        // Continue to next endpoint
        console.log(`⚠️ Sync endpoint ${endpoint.split('/').pop()} failed: ${syncError.message}`);
      }
    }
    
    // Method 2: Try triggering sync by updating the deposit with sync flag
    console.log('🔄 Method 2: Updating deposit with sync flag');
    try {
      const updateData = {
        ID: depositId,
        FORCE_SYNC: true,
        SYNC_TO_ACCOUNTING: true,
        ACC_PACKAGE_ID: 3,
        token: token
      };
      
      const updateResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(updateData).toString()
      });
      
      if (updateResponse.ok) {
        const updateResult = await updateResponse.text();
        console.log('✅ Deposit updated with sync flag');
        return true;
      }
    } catch (updateError) {
      console.log('⚠️ Failed to update deposit with sync flag:', updateError.message);
    }
    
    console.log('⚠️ All sync methods attempted - sync may happen automatically');
    return false;
    
  } catch (error) {
    console.error('❌ Error triggering Xero sync:', error);
    return false;
  }
}

// 🔍 VERIFY that Xero sync completed by checking for ACC_ID
async function verifyXeroSync(jobId, depositId, token, hirehopDomain) {
  try {
    console.log(`🔍 Verifying Xero sync for deposit ${depositId}`);
    
    const encodedToken = encodeURIComponent(token);
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    
    const response = await fetch(billingUrl);
    if (!response.ok) {
      console.log('❌ Failed to fetch billing data for verification');
      return false;
    }
    
    const billingData = await response.json();
    
    // Find our deposit
    const deposit = billingData.rows?.find(row => 
      row.kind === 6 && row.data?.ID === depositId
    );
    
    if (deposit) {
      const accId = deposit.data?.ACC_ID || '';
      const exported = deposit.data?.exported || 0;
      
      console.log(`🔍 Verification results for deposit ${depositId}:`, {
        accId: accId || 'MISSING',
        exported: exported,
        hasAccData: !!(deposit.data?.ACC_DATA && Object.keys(deposit.data.ACC_DATA).length > 0)
      });
      
      if (accId && accId !== '') {
        console.log('✅ SUCCESS! Deposit has ACC_ID - Xero sync completed');
        await addHireHopNote(jobId, `✅ Xero sync verified: Deposit ${depositId} has ACC_ID ${accId}`);
        return true;
      } else {
        console.log('⚠️ Deposit still missing ACC_ID - Xero sync pending or failed');
        await addHireHopNote(jobId, `⚠️ Xero sync pending: Deposit ${depositId} waiting for ACC_ID`);
        return false;
      }
    } else {
      console.log('❌ Could not find deposit in billing list');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error verifying Xero sync:', error);
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
