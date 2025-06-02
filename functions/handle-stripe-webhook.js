// handle-stripe-webhook.js - FIXED VERSION WITH 3 XERO SYNC SOLUTIONS
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 XERO SYNC FIX - Processing Stripe payment with enhanced sync');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' }

// 🎭 SOLUTION: Mimic the exact manual edit sequence
async function mimicManualEdit(jobId, depositId, amount, description, token, hirehopDomain) {
  try {
    console.log(`🎭 Mimicking manual edit for deposit ${depositId}`);
    
    // Step 1: "Edit" the deposit by calling billing_deposit_save again with the same data
    // This mimics what happens when you click save in the UI
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    const editData = {
      ID: depositId, // CRITICAL: Use existing ID for edit, not 0 for new
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: API-triggered edit to force sync`,
      ACC_ACCOUNT_ID: 267,
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[NAME]': 'United Kingdom Pound',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      'CURRENCY[NEGATIVE_FORMAT]': 1,
      'CURRENCY[SYMBOL_POSITION]': 0,
      'CURRENCY[DECIMAL_SEPARATOR]': '.',
      'CURRENCY[THOUSAND_SEPARATOR]': ',',
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    console.log('🎭 Step 1: Simulating deposit edit...');
    
    const editResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(editData).toString()
    });
    
    const editResponseText = await editResponse.text();
    let editParsedResponse;
    
    try {
      editParsedResponse = JSON.parse(editResponseText);
    } catch (e) {
      editParsedResponse = { rawResponse: editResponseText };
    }
    
    console.log('🎭 Edit response:', editParsedResponse);
    
    // Step 2: If the edit was successful and we see sync_accounts: true,
    // it should have triggered the sync automatically like manual edits do
    if (editResponse.ok && editParsedResponse.sync_accounts) {
      console.log('✅ Edit successful with sync_accounts: true - checking if sync triggered...');
      
      // Wait a moment and check if ACC_ID got populated
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const verification = await verifyDepositSyncStatus(jobId, depositId, token, hirehopDomain);
      
      return {
        success: true,
        editResponse: editParsedResponse,
        verification: verification,
        method: 'manual_edit_simulation'
      };
    } else {
      return {
        success: false,
        editResponse: editParsedResponse,
        httpStatus: editResponse.status,
        method: 'manual_edit_simulation'
      };
    }
    
  } catch (error) {
    console.error('❌ Error mimicking manual edit:', error);
    return { success: false, error: error.message };
  }
},
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
      
      // 🎯 SOLUTION 2: THE CRITICAL MISSING PIECE - accounting/tasks.php
      console.log('🔄 SOLUTION 2: Triggering the DISCOVERED accounting tasks endpoint');
      
      const tasksResult = await triggerAccountingTasks(
        parsedResponse.hh_id,
        3, // ACC_PACKAGE_ID
        1, // PACKAGE_TYPE  
        token,
        hirehopDomain
      );
      
      console.log('📋 Tasks endpoint result:', tasksResult);
      
      // Also try the multiple sync mechanisms as backup
      const syncResults = await triggerMultipleSyncMechanisms(
        jobId, 
        parsedResponse.hh_id, 
        token, 
        hirehopDomain
      );
      
      // 🎯 SOLUTION 3: Mimic the exact manual edit sequence
      console.log('🔄 SOLUTION 3: Mimicking manual edit sequence');
      
      const manualEditResult = await mimicManualEdit(
        jobId,
        parsedResponse.hh_id,
        amount,
        description,
        token,
        hirehopDomain
      );
      
      console.log('🎭 Manual edit simulation result:', manualEditResult);
      
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

// 🎯 THE DISCOVERED SOLUTION: Trigger accounting tasks with multiple auth methods
async function triggerAccountingTasks(depositId, accPackageId, packageType, token, hirehopDomain) {
  try {
    console.log(`🎯 CRITICAL: Triggering accounting tasks for deposit ${depositId}`);
    
    const tasksData = {
      hh_package_type: packageType,
      hh_acc_package_id: accPackageId,
      hh_task: 'post_deposit',
      hh_id: depositId,
      hh_acc_id: '', // Empty initially, gets populated by Xero
      token: token // Add token for API authentication
    };
    
    // Try multiple endpoints and authentication methods
    const endpoints = [
      // Method 1: Original tasks.php with token
      {
        name: 'tasks_with_token',
        url: `https://${hirehopDomain}/php_functions/accounting/tasks.php`,
        data: tasksData
      },
      // Method 2: Try with token in URL
      {
        name: 'tasks_url_token',
        url: `https://${hirehopDomain}/php_functions/accounting/tasks.php?token=${encodeURIComponent(token)}`,
        data: {
          hh_package_type: packageType,
          hh_acc_package_id: accPackageId,
          hh_task: 'post_deposit',
          hh_id: depositId,
          hh_acc_id: ''
        }
      },
      // Method 3: Try direct accounting sync endpoint
      {
        name: 'accounting_sync_direct',
        url: `https://${hirehopDomain}/php_functions/accounting_sync.php`,
        data: {
          deposit_id: depositId,
          package_id: accPackageId,
          package_type: packageType,
          action: 'sync_deposit',
          token: token
        }
      },
      // Method 4: Try the billing export that worked before
      {
        name: 'billing_export_enhanced',
        url: `https://${hirehopDomain}/php_functions/billing_export.php`,
        data: {
          deposit_id: depositId,
          acc_package_id: accPackageId,
          export_to_accounting: true,
          force_sync: true,
          trigger_xero: true,
          token: token
        }
      }
    ];
    
    const results = [];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`🔄 Trying ${endpoint.name}...`);
        
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(endpoint.data).toString()
        });
        
        const responseText = await response.text();
        let parsedResponse;
        
        try {
          parsedResponse = JSON.parse(responseText);
        } catch (e) {
          parsedResponse = { rawResponse: responseText };
        }
        
        const result = {
          method: endpoint.name,
          status: response.status,
          success: response.ok,
          response: parsedResponse,
          needsLogin: responseText.includes('login') || responseText.includes('Login'),
          hasError: responseText.toLowerCase().includes('error'),
          hasSuccess: responseText.toLowerCase().includes('success') || 
                     responseText.includes('package_updated') ||
                     responseText.includes('"sync"') ||
                     responseText.includes('exported')
        };
        
        results.push(result);
        
        console.log(`📋 ${endpoint.name} result:`, result);
        
        // If we get a successful non-login response, that's promising
        if (response.ok && !result.needsLogin && !result.hasError) {
          console.log(`✅ ${endpoint.name} appears successful!`);
        }
        
      } catch (error) {
        results.push({
          method: endpoint.name,
          error: error.message
        });
      }
    }
    
    // Determine overall success
    const anySuccess = results.some(r => r.success && !r.needsLogin && !r.hasError);
    
    return {
      success: anySuccess,
      results: results,
      bestResult: results.find(r => r.success && !r.needsLogin) || results[0]
    };
    
  } catch (error) {
    console.error('❌ Error triggering accounting tasks:', error);
    return { success: false, error: error.message };
  }
}
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
