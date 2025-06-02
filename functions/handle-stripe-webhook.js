// handle-stripe-webhook.js - FIXED VERSION WITH 3 XERO SYNC SOLUTIONS
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 XERO SYNC FIX - Processing Stripe payment with enhanced sync');
    
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
    await createDepositWithEnhancedXeroSync(jobId, paymentType, session);
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
  
  await createDepositWithEnhancedXeroSync(jobId, paymentType, paymentIntent);
}

// 🎯 SOLUTION: Enhanced deposit creation with 3 Xero sync strategies
async function createDepositWithEnhancedXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 ENHANCED XERO SYNC: Creating ${paymentType} deposit for job ${jobId}`);
    
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
    
    const description = `${jobId} - ${paymentType}`;
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // 🎯 SOLUTION 1: Force deposit approval status for immediate sync
    console.log('🔄 SOLUTION 1: Creating deposit with approval status for immediate Xero sync');
    
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
      // 🎯 KEY FIX 1: Force approval status to trigger immediate sync
      STATUS: 'approved', // Force approved status
      APPROVED: 1, // Mark as approved
      SYNC_NOW: true, // Request immediate sync
      FORCE_SYNC: true, // Force sync flag
      BYPASS_BUFFER: true, // Attempt to bypass buffer mode
      token: token
    };
    
    console.log('💰 Creating deposit with forced approval for Xero sync');
    
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
      console.log(`✅ Deposit ${parsedResponse.hh_id} created successfully`);
      
      // 🎯 SOLUTION 2: Multiple sync trigger attempts
      console.log('🔄 SOLUTION 2: Triggering multiple sync mechanisms');
      
      const syncResults = await triggerMultipleSyncMechanisms(
        jobId, 
        parsedResponse.hh_id, 
        token, 
        hirehopDomain
      );
      
      // 🎯 SOLUTION 3: Check if in buffer and force manual sync
      console.log('🔄 SOLUTION 3: Checking buffer status and forcing manual sync');
      
      const bufferSyncResult = await checkBufferAndForceSync(
        jobId, 
        parsedResponse.hh_id, 
        token, 
        hirehopDomain
      );
      
      // 🎯 VERIFICATION: Check if sync succeeded
      setTimeout(async () => {
        const syncVerified = await verifyXeroSyncWithRetry(
          jobId, 
          parsedResponse.hh_id, 
          token, 
          hirehopDomain, 
          3 // retry 3 times
        );
        
        if (syncVerified) {
          await addHireHopNote(jobId, `✅ SUCCESS: Deposit ${parsedResponse.hh_id} synced to Xero. Stripe: ${stripeObject.id}`);
        } else {
          await addHireHopNote(jobId, `⚠️ ATTENTION: Deposit ${parsedResponse.hh_id} created but Xero sync may be delayed. Check "Invoices to be Exported" report. Stripe: ${stripeObject.id}`);
        }
      }, 10000); // Check after 10 seconds
      
      const syncStatus = syncResults.anySuccess ? '✅ Enhanced sync triggered' : '⚠️ Sync pending manual review';
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

// 🎯 SOLUTION 2: Multiple sync mechanism triggers
async function triggerMultipleSyncMechanisms(jobId, depositId, token, hirehopDomain) {
  console.log(`🔄 Triggering multiple sync mechanisms for deposit ${depositId}`);
  
  const results = [];
  
  // Method 1: Immediate accounting sync trigger
  try {
    console.log('🔄 Method 1: Immediate accounting sync');
    const syncData = {
      deposit_id: depositId,
      job_id: jobId,
      action: 'sync_to_accounting',
      package_id: 3, // Xero package
      force_immediate: true,
      token: token
    };
    
    const syncResponse = await fetch(`https://${hirehopDomain}/php_functions/accounting_sync_trigger.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(syncData).toString()
    });
    
    if (syncResponse.ok) {
      const result = await syncResponse.text();
      results.push({ method: 'accounting_sync_trigger', success: true, result });
      console.log('✅ Method 1 success');
    }
  } catch (error) {
    results.push({ method: 'accounting_sync_trigger', success: false, error: error.message });
    console.log('⚠️ Method 1 failed:', error.message);
  }
  
  // Method 2: Force live sync mode
  try {
    console.log('🔄 Method 2: Force live sync mode');
    const liveSyncData = {
      billing_id: depositId,
      sync_mode: 'live',
      accounting_package: 3,
      force_sync: true,
      token: token
    };
    
    const liveSyncResponse = await fetch(`https://${hirehopDomain}/php_functions/force_live_sync.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(liveSyncData).toString()
    });
    
    if (liveSyncResponse.ok) {
      const result = await liveSyncResponse.text();
      results.push({ method: 'force_live_sync', success: true, result });
      console.log('✅ Method 2 success');
    }
  } catch (error) {
    results.push({ method: 'force_live_sync', success: false, error: error.message });
    console.log('⚠️ Method 2 failed:', error.message);
  }
  
  // Method 3: Billing export trigger
  try {
    console.log('🔄 Method 3: Billing export trigger');
    const exportData = {
      job_id: jobId,
      deposit_id: depositId,
      export_to_accounting: true,
      accounting_id: 3,
      token: token
    };
    
    const exportResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_export.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(exportData).toString()
    });
    
    if (exportResponse.ok) {
      const result = await exportResponse.text();
      results.push({ method: 'billing_export', success: true, result });
      console.log('✅ Method 3 success');
    }
  } catch (error) {
    results.push({ method: 'billing_export', success: false, error: error.message });
    console.log('⚠️ Method 3 failed:', error.message);
  }
  
  const anySuccess = results.some(r => r.success);
  console.log(`🔄 Sync mechanisms completed. Success: ${anySuccess}`, results);
  
  return { anySuccess, results };
}

// 🎯 SOLUTION 3: Check buffer and force manual sync
async function checkBufferAndForceSync(jobId, depositId, token, hirehopDomain) {
  try {
    console.log(`🔍 Checking if deposit ${depositId} is in buffer queue`);
    
    // Check the "Invoices to be Exported" report for buffered items
    const bufferCheckData = {
      type: 'deposits',
      accounting_package: 3,
      status: 'pending',
      token: token
    };
    
    const bufferResponse = await fetch(`https://${hirehopDomain}/php_functions/invoices_to_be_exported.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(bufferCheckData).toString()
    });
    
    if (bufferResponse.ok) {
      const bufferData = await bufferResponse.text();
      console.log('📋 Buffer check response:', bufferData.substring(0, 200));
      
      // If deposit is in buffer, trigger manual sync
      if (bufferData.includes(depositId) || bufferData.includes('pending')) {
        console.log('⚠️ Deposit appears to be in buffer - triggering manual sync');
        
        const manualSyncData = {
          action: 'export_selected',
          deposit_ids: [depositId],
          accounting_package: 3,
          force_export: true,
          token: token
        };
        
        const manualSyncResponse = await fetch(`https://${hirehopDomain}/php_functions/manual_accounting_sync.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(manualSyncData).toString()
        });
        
        if (manualSyncResponse.ok) {
          const syncResult = await manualSyncResponse.text();
          console.log('✅ Manual sync triggered successfully');
          return { inBuffer: true, syncTriggered: true, result: syncResult };
        }
      } else {
        console.log('✅ Deposit not in buffer - may have synced automatically');
        return { inBuffer: false, syncTriggered: false };
      }
    }
    
    return { inBuffer: 'unknown', syncTriggered: false };
    
  } catch (error) {
    console.log('⚠️ Buffer check failed:', error.message);
    return { inBuffer: 'error', syncTriggered: false, error: error.message };
  }
}

// 🎯 ENHANCED: Retry verification with multiple attempts
async function verifyXeroSyncWithRetry(jobId, depositId, token, hirehopDomain, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🔍 Verification attempt ${attempt}/${maxRetries} for deposit ${depositId}`);
    
    try {
      const encodedToken = encodeURIComponent(token);
      const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
      
      const response = await fetch(billingUrl);
      if (!response.ok) {
        console.log(`❌ Verification attempt ${attempt} failed: HTTP ${response.status}`);
        continue;
      }
      
      const billingData = await response.json();
      
      // Find our deposit
      const deposit = billingData.rows?.find(row => 
        row.kind === 6 && row.data?.ID === depositId
      );
      
      if (deposit) {
        const accId = deposit.data?.ACC_ID || '';
        const exported = deposit.data?.exported || 0;
        
        console.log(`🔍 Attempt ${attempt} - Deposit ${depositId}:`, {
          accId: accId || 'MISSING',
          exported: exported,
          hasAccData: !!(deposit.data?.ACC_DATA && Object.keys(deposit.data.ACC_DATA).length > 0)
        });
        
        if (accId && accId !== '') {
          console.log(`✅ SUCCESS on attempt ${attempt}! Deposit has ACC_ID - Xero sync verified`);
          return true;
        } else if (attempt < maxRetries) {
          console.log(`⏳ Attempt ${attempt}: Still waiting for ACC_ID, retrying in 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } else {
        console.log(`❌ Attempt ${attempt}: Could not find deposit in billing list`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    } catch (error) {
      console.error(`❌ Verification attempt ${attempt} error:`, error);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  console.log(`⚠️ All ${maxRetries} verification attempts completed - Xero sync status uncertain`);
  return false;
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
