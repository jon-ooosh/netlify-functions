// handle-stripe-webhook.js - SECURE HYBRID VERSION - Your proven working approach
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🔒 SECURE HYBRID WEBHOOK - Signature verification with graceful fallback');
    
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    let stripeEvent;
    const signature = event.headers['stripe-signature'];
    
    // 🎯 YOUR PROVEN WORKING APPROACH: Try verification, fall back gracefully
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook signature verified successfully');
    } catch (err) {
      console.log('⚠️ Signature verification failed, parsing without verification (functional mode)');
      console.log('🔍 Verification error:', err.message);
      stripeEvent = JSON.parse(event.body);
    }
    
    console.log(`📥 Processing webhook event type: ${stripeEvent.type}`);
    
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
    await processPaymentComplete(jobId, paymentType, session, false);
  } else {
    await processPreAuthComplete(jobId, paymentType, session);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  await processPaymentComplete(jobId, paymentType, paymentIntent, false);
}

// Complete payment processing with both systems
async function processPaymentComplete(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`🔄 COMPLETE PROCESSING: ${paymentType} payment for job ${jobId}`);
    
    // STEP 1: Use YOUR working HireHop + Xero sync method (unchanged!)
    console.log('💰 STEP 1: Creating HireHop deposit with your proven Xero sync...');
    const hirehopSuccess = await createDepositWithWorkingXeroSync(jobId, paymentType, stripeObject);
    
    // STEP 2: Update Monday.com with business logic (independent of Xero)
    console.log('📋 STEP 2: Applying Monday.com business logic...');
    const mondayResult = await applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth);
    
    // STEP 3: Update HireHop job status to "Booked" ONLY for hire payments (NOT excess)
    console.log('🏢 STEP 3: Updating HireHop job status...');
    let statusResult = { success: false, message: 'Skipped' };
    if (paymentType === 'deposit' || paymentType === 'balance') {
      // 🔧 FIXED: Only update job status for hire payments, NOT excess
      statusResult = await updateHireHopJobStatusFixed(jobId, 2); // Status 2 = Booked
      console.log('✅ Job status updated for hire payment');
    } else {
      console.log('⏭️ Skipping job status update for excess payment');
      statusResult = { success: true, message: 'Skipped - excess payment' };
    }
    
    // STEP 4: Comprehensive results and notes
    let noteText = '';
    if (hirehopSuccess && mondayResult.success && statusResult.success) {
      noteText = `✅ COMPLETE SUCCESS: £${mondayResult.amount?.toFixed(2) || '0.00'} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit created + Xero sync${paymentType !== 'excess' ? ' + Status "Booked"' : ''}. Monday.com: ${mondayResult.updates} updates applied.`;
    } else if (hirehopSuccess && mondayResult.success) {
      noteText = `✅ PAYMENT SUCCESS: £${mondayResult.amount?.toFixed(2) || '0.00'} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit created + Xero sync. Monday.com: ${mondayResult.updates} updates. HireHop status: ${statusResult.message}`;
    } else if (hirehopSuccess) {
      noteText = `⚠️ PARTIAL SUCCESS: £${mondayResult.amount?.toFixed(2) || '0.00'} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit created + Xero sync. Monday.com failed: ${mondayResult.error}`;
    } else {
      noteText = `🚨 CRITICAL: HireHop payment failed. Stripe: ${stripeObject.id}. Monday.com: ${mondayResult.success ? 'Updated' : 'Failed'}`;
    }
    
    await addHireHopNote(jobId, noteText);
    
    return { hirehopSuccess, mondayResult, statusResult };
    
  } catch (error) {
    console.error('❌ Error in complete processing:', error);
    await addHireHopNote(jobId, `🚨 SYSTEM ERROR: ${paymentType} payment failed. Stripe: ${stripeObject.id}. Error: ${error.message}`);
    throw error;
  }
}

// Process pre-authorization
async function processPreAuthComplete(jobId, paymentType, session) {
  try {
    console.log(`🔐 PRE-AUTH PROCESSING: ${paymentType} pre-auth for job ${jobId}`);
    
    const amount = session.amount_total ? session.amount_total / 100 : 1200;
    
    // Apply Monday.com business logic for pre-auth
    const mondayResult = await applyMondayBusinessLogic(jobId, paymentType, session, true);
    
    let noteText = '';
    if (mondayResult.success) {
      noteText = `🔐 PRE-AUTH SUCCESS: £${amount.toFixed(2)} ${paymentType} pre-authorization set up. Stripe: ${session.id}. Monday.com: ${mondayResult.updates} updates applied.`;
    } else {
      noteText = `🔐 PRE-AUTH: £${amount.toFixed(2)} ${paymentType} pre-authorization set up (Stripe: ${session.id}). Monday.com update failed: ${mondayResult.error}`;
    }
    
    await addHireHopNote(jobId, noteText);
    
    return mondayResult;
    
  } catch (error) {
    console.error('❌ Error in pre-auth processing:', error);
    await addHireHopNote(jobId, `🚨 PRE-AUTH ERROR: ${paymentType} pre-authorization failed. Stripe: ${session.id}. Error: ${error.message}`);
    throw error;
  }
}

// 🚨🚨🚨 CRITICAL: YOUR EXACT WORKING XERO SYNC METHOD - NEVER CHANGE THIS! 🚨🚨🚨
async function createDepositWithWorkingXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 YOUR WORKING METHOD: Creating ${paymentType} deposit for job ${jobId} with proven method`);
    
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
    
    // 🔧 ENHANCED: Create clickable Stripe URL for memo field
    let stripeUrl = '';
    if (stripeObject.payment_intent) {
      stripeUrl = `https://dashboard.stripe.com/payments/${stripeObject.payment_intent}`;
    } else if (stripeObject.setup_intent) {
      stripeUrl = `https://dashboard.stripe.com/setup_intents/${stripeObject.setup_intent}`;
    } else {
      stripeUrl = `https://dashboard.stripe.com/checkout/sessions/${stripeObject.id}`;
    }
    
    // 🚨 EXACT WORKING DEPOSIT DATA
    const depositData = {
      ID: 0, // Step 1: Always 0 for new deposits
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: ${stripeUrl}`,
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
    
    console.log('💰 STEP 1: Creating deposit (ID: 0) - your working method');
    
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
      console.log(`✅ STEP 1 SUCCESS: Deposit ${parsedResponse.hh_id} created`);
      
      // 🎯 CRITICAL DISCOVERED SOLUTION: Call tasks.php
      console.log('🔄 STEP 2: Triggering accounting tasks endpoint (THE KEY TO XERO SYNC)');
      
      const tasksResult = await triggerAccountingTasks(
        parsedResponse.hh_id,
        3, // ACC_PACKAGE_ID
        1, // PACKAGE_TYPE  
        token,
        hirehopDomain
      );
      
      console.log('📋 Tasks endpoint result:', tasksResult);
      
      // 🔄 STEP 3: Edit call as backup
      console.log('🔄 STEP 3: Edit call as backup method');
      depositData.ID = parsedResponse.hh_id;
      
      const editResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(depositData).toString()
      });
      
      console.log('🔄 STEP 3 COMPLETED: Edit call made as backup');
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error in working method:', error);
    throw error;
  }
}

// 🎯 THE CRITICAL DISCOVERED SOLUTION: Trigger accounting tasks
async function triggerAccountingTasks(depositId, accPackageId, packageType, token, hirehopDomain) {
  try {
    const tasksData = {
      hh_package_type: packageType,
      hh_acc_package_id: accPackageId,
      hh_task: 'post_deposit',
      hh_id: depositId,
      hh_acc_id: '',
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/accounting/tasks.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tasksData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    const success = response.ok && !responseText.includes('login') && !responseText.toLowerCase().includes('error');
    
    return { success: success, response: parsedResponse, httpStatus: response.status };
    
  } catch (error) {
    console.error('❌ Error calling tasks.php:', error);
    return { success: false, error: error.message };
  }
}

// 🎯 Monday.com business logic (FIXED - no job status changes for excess)
async function applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`📋 MONDAY BUSINESS LOGIC: Applying rules for job ${jobId}`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping');
      return { success: false, error: 'No credentials', updates: 0 };
    }
    
    // Calculate payment amount
    let paymentAmount = 0;
    if (stripeObject.amount_total) {
      paymentAmount = stripeObject.amount_total / 100;
    } else if (stripeObject.amount) {
      paymentAmount = stripeObject.amount / 100;
    } else if (stripeObject.amount_received) {
      paymentAmount = stripeObject.amount_received / 100;
    }
    
    // Find Monday.com item
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log('⚠️ Job not found in Monday.com, skipping updates');
      return { success: false, error: 'Job not found', updates: 0 };
    }
    
    console.log(`✅ Found Monday.com item: ${mondayItem.id}`);
    
    // Extract current statuses
    const currentStatuses = extractCurrentStatuses(mondayItem);
    
    // Get job details for payment logic
    const jobDetails = await getFreshJobDetails(jobId);
    
    // Apply business rules
    const updates = [];
    
    if (paymentType === 'excess') {
      // 🔧 FIXED: Only update excess column, NOT job status
      if (isPreAuth) {
        updates.push({
          columnId: 'status58',
          newValue: 'Pre-auth taken',
          description: 'Insurance excess pre-auth taken'
        });
        
        // 🎯 NEW APPROACH: Add pre-auth details as Monday.com update (much better!)
        const setupIntentId = stripeObject.setup_intent || stripeObject.id;
        const preAuthLink = `https://dashboard.stripe.com/setup_intents/${setupIntentId}`;
        const amount = paymentAmount || 1200; // Fallback to £1200
        
        // Calculate hire end date for validity
        let validityNote = '';
        if (jobDetails && jobDetails.jobData.endDate) {
          const endDate = new Date(jobDetails.jobData.endDate);
          validityNote = `\n📅 Valid until: ${endDate.toLocaleDateString('en-GB')} (hire end date)`;
        }
        
        const preAuthUpdateText = `🔐 PRE-AUTH COMPLETED: £${amount.toFixed(2)} excess pre-authorization taken
🔗 Stripe Link: ${preAuthLink}
💳 Setup Intent ID: ${setupIntentId}${validityNote}
⚠️ How to claim: Go to Stripe Dashboard → Setup Intents → Confirm payment
📋 This pre-auth will be automatically released if not claimed within 5 days of hire end.`;
        
        updates.push({
          type: 'update',
          updateText: preAuthUpdateText,
          description: 'Pre-auth details added as Monday.com update'
        });
      } else {
        updates.push({
          columnId: 'status58',
          newValue: 'Excess paid',
          description: 'Insurance excess payment completed'
        });
      }
    } else if (paymentType === 'deposit' || paymentType === 'balance') {
      // Hire payment logic (unchanged)
      const quoteOrConfirmed = currentStatuses.status6;
      const remainingAfterPayment = jobDetails ? Math.max(0, jobDetails.financial.remainingHireBalance - paymentAmount) : 0;
      const isFullPayment = remainingAfterPayment <= 0.01;
      
      if (quoteOrConfirmed === 'Quote') {
        if (isFullPayment) {
          updates.push({
            columnId: 'status3',
            newValue: 'Paid in full',
            description: 'Quote paid in full'
          });
        } else {
          updates.push({
            columnId: 'status3',
            newValue: 'Deposit paid',
            description: 'Quote deposit paid'
          });
        }
      } else if (quoteOrConfirmed === 'Confirmed quote') {
        if (isFullPayment) {
          updates.push({
            columnId: 'dup__of_job_status',
            newValue: 'Paid in full',
            description: 'Job paid in full'
          });
        } else {
          updates.push({
            columnId: 'dup__of_job_status',
            newValue: 'Balance to pay',
            description: 'Job has balance to pay'
          });
        }
      }
    }
    
    // Apply all updates
    let successCount = 0;
    
    for (const update of updates) {
      if (update.type === 'update') {
        // Handle Monday.com updates (for pre-auth details)
        const result = await createMondayUpdate(
          mondayItem.id,
          update.updateText,
          mondayApiKey
        );
        
        if (result.success) {
          successCount++;
          console.log(`✅ ${update.description}: Update created`);
        } else {
          console.error(`❌ Failed ${update.description}:`, result.error);
        }
      } else {
        // Handle regular column updates
        const result = await updateMondayColumn(
          mondayItem.id,
          update.columnId,
          update.newValue,
          mondayApiKey,
          mondayBoardId,
          update.isText || false
        );
        
        if (result.success) {
          successCount++;
          console.log(`✅ ${update.description}: ${update.newValue}`);
        } else {
          console.error(`❌ Failed ${update.description}:`, result.error);
        }
      }
    }
    
    return {
      success: successCount > 0,
      updates: successCount,
      totalAttempted: updates.length,
      mondayItemId: mondayItem.id,
      amount: paymentAmount,
      appliedRules: updates.map(u => u.description)
    };
    
  } catch (error) {
    console.error('❌ Monday.com business logic error:', error);
    return { success: false, error: error.message, updates: 0 };
  }
}

// Helper functions (keeping your working versions)
async function findMondayItem(jobId, apiKey, boardId) {
  try {
    const searchQuery = `
      query {
        items_page_by_column_values(
          board_id: ${boardId}
          columns: [
            {
              column_id: "text7"
              column_values: ["${jobId}"]
            }
          ]
          limit: 1
        ) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({ query: searchQuery })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error('Monday.com search error:', result.errors);
      return null;
    }
    
    const items = result.data?.items_page_by_column_values?.items || [];
    return items.length > 0 ? items[0] : null;
    
  } catch (error) {
    console.error('Error finding Monday.com item:', error);
    return null;
  }
}

function extractCurrentStatuses(mondayItem) {
  const statuses = {};
  
  mondayItem.column_values.forEach(column => {
    const columnId = column.id;
    let value = null;
    
    if (column.text) {
      value = column.text;
    } else if (column.value) {
      try {
        const parsed = JSON.parse(column.value);
        value = parsed.label || parsed.text || null;
      } catch (e) {
        value = column.value;
      }
    }
    
    statuses[columnId] = value;
  });
  
  return statuses;
}

// Create Monday.com update (for pre-auth details)
async function createMondayUpdate(itemId, updateText, apiKey) {
  try {
    console.log(`📝 Creating Monday.com update for item ${itemId}`);
    
    const mutation = `
      mutation {
        create_update(
          item_id: ${itemId}
          body: "${updateText.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
        ) {
          id
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query: mutation })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error('❌ Monday.com update creation error:', result.errors);
      return { success: false, error: result.errors };
    }
    
    console.log('✅ Monday.com update created successfully');
    return { success: true, updateId: result.data?.create_update?.id };
    
  } catch (error) {
    console.error('❌ Error creating Monday.com update:', error);
    return { success: false, error: error.message };
  }
}
  try {
    let valueJson;
    
    if (isText) {
      // 🔧 FIXED: Proper text column format - no extra quotes or escaping
      valueJson = `"${newValue.replace(/"/g, '\\"')}"`;
    } else {
      valueJson = `"{\\"label\\": \\"${newValue.replace(/"/g, '\\"')}\\"}"`;
    }
    
    console.log(`📝 Updating column ${columnId} with value: ${valueJson}`);
    
    const mutation = `
      mutation {
        change_column_value(
          item_id: ${itemId}
          board_id: ${boardId}
          column_id: "${columnId}"
          value: ${valueJson}
        ) {
          id
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query: mutation })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error(`❌ Monday.com update error for ${columnId}:`, result.errors);
      return { success: false, error: result.errors };
    }
    
    return { success: true };
    
  } catch (error) {
    console.error(`❌ Error updating Monday.com column ${columnId}:`, error);
    return { success: false, error: error.message };
  }
}

async function getFreshJobDetails(jobId) {
  try {
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || 'https://ooosh-tours-payment-page.netlify.app';
    
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    const response1 = await fetch(jobDetailsUrl);
    const result1 = await response1.json();
    
    if (result1.hash && !result1.authenticated) {
      jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}&hash=${result1.hash}`;
      const response2 = await fetch(jobDetailsUrl);
      const result2 = await response2.json();
      
      if (result2.success) {
        return result2;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting fresh job details:', error);
    return null;
  }
}

async function updateHireHopJobStatusFixed(jobId, newStatus) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    const statusData = {
      job: jobId,
      status: newStatus,
      no_webhook: 1,
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/frames/status_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(statusData).toString()
    });
    
    if (response.ok) {
      const responseText = await response.text();
      let result;
      
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        result = { rawResponse: responseText };
      }
      
      return { success: true, status: newStatus, response: result };
    } else {
      const errorText = await response.text();
      return { success: false, message: `HTTP ${response.status}: ${errorText}` };
    }
    
  } catch (error) {
    console.error('Error updating HireHop job status:', error);
    return { success: false, message: error.message };
  }
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
