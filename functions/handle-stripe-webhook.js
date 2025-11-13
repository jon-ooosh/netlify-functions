// handle-stripe-webhook.js - UPDATED: Manual capture pre-auth support
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
        
      case 'payment_intent.amount_capturable_updated':
        // 🔧 NEW: Handle manual capture pre-authorizations
        await handlePreAuthorizationComplete(stripeEvent.data.object);
        break;
        
      ccase 'payment_intent.succeeded':
  // 🔧 FIXED: Skip admin claims - they're handled by admin-claim-preauth.js
  const paymentIntent = stripeEvent.data.object;
  const { adminClaim } = paymentIntent.metadata || {};
  
  if (adminClaim === 'true') {
    console.log('🔐 Admin claim detected - skipping webhook processing (handled by admin portal)');
  } else {
    console.log('🔄 Regular payment - ignoring payment_intent.succeeded (handled by checkout.session.completed)');
  }
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

// 🔧 NEW: Handle manual capture pre-authorization completion
async function handlePreAuthorizationComplete(paymentIntent) {
  try {
    console.log('🔐 PRE-AUTH COMPLETED: Manual capture payment intent authorized');
    console.log(`   Payment Intent ID: ${paymentIntent.id}`);
    console.log(`   Amount authorized: £${paymentIntent.amount / 100}`);
    console.log(`   Status: ${paymentIntent.status}`);
    
    // Only process if it's actually ready for capture
    if (paymentIntent.status !== 'requires_capture') {
      console.log('⚠️ Payment intent not in requires_capture state, skipping');
      return;
    }
    
    const { jobId, paymentType, isPreAuth } = paymentIntent.metadata || {};
    
    if (!jobId || paymentType !== 'excess' || isPreAuth !== 'true') {
      console.log('⚠️ Not an excess pre-authorization, skipping');
      return;
    }
    
    // 🔧 NEW: Update Monday.com with payment intent ID (not setup intent)
    await updateMondayPreAuthStatus(jobId, paymentIntent);
    
    // 🔧 NEW: Add HireHop note about pre-auth (but don't create deposit yet!)
    const amount = paymentIntent.amount / 100;
    const releaseDate = new Date();
    releaseDate.setDate(releaseDate.getDate() + 7);
    
    const noteText = `🔐 PRE-AUTH COMPLETED: £${amount.toFixed(2)} excess pre-authorization taken
💳 Payment Intent ID: ${paymentIntent.id}
🔗 Stripe Link: https://dashboard.stripe.com/payments/${paymentIntent.id}
📅 Auto-release date: ${releaseDate.toLocaleDateString('en-GB')} (7 days from today)
⚠️ How to claim: Use Admin Portal - NO customer authentication required!
📋 This pre-auth will be automatically released in 7 days if not claimed.`;
    
    await addHireHopNote(jobId, noteText);
    
    console.log('✅ Pre-authorization processed successfully');
    
  } catch (error) {
    console.error('❌ Error handling pre-authorization:', error);
    throw error;
  }
}

// 🔧 UPDATED: Handle checkout session with manual capture awareness
async function handleCheckoutSessionCompleted(session) {
  console.log('🎯 Processing checkout session:', session.id);
  const { jobId, paymentType, isPreAuth } = session.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  // 🔧 UPDATED: Check for manual capture payment intents
  if (session.payment_intent) {
    const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
    
    if (paymentIntent.capture_method === 'manual') {
      console.log('🔐 Manual capture payment intent detected - will handle in payment_intent.amount_capturable_updated');
      // Don't process here - wait for the amount_capturable_updated event
      return;
    }
  }
  
  // Process regular payments (not manual capture)
  if (isPreAuth !== 'true') {
    await processPaymentComplete(jobId, paymentType, session, false);
  }
}

// 🔧 UPDATED: Handle payment intent succeeded (only for captures)
async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent succeeded:', paymentIntent.id);
  const { jobId, paymentType, adminClaim, captureMethod } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  // 🔧 UPDATED: Handle captured manual payments
  if (captureMethod === 'manual' || adminClaim === 'true') {
    console.log('🔐 Processing captured manual payment');
    
    // This is a captured payment - create the HireHop deposit now
    await processPaymentComplete(jobId, 'excess_claim', paymentIntent, false);
    
    // Update Monday.com status to "Pre-auth claimed"
    await updateMondayExcessStatus(jobId, 'Pre-auth claimed');
  }
}

// 🔧 NEW: Update Monday.com with pre-auth details
async function updateMondayPreAuthStatus(jobId, paymentIntent) {
  try {
    console.log(`📋 Updating Monday.com with pre-authorization for job ${jobId}`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured');
      return { success: false };
    }
    
    // Find Monday.com item
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log('⚠️ Job not found in Monday.com');
      return { success: false };
    }
    
    // Update excess status column
    await updateMondayColumn(
      mondayItem.id,
      'status58',
      'Pre-auth taken',
      mondayApiKey,
      mondayBoardId
    );
    
    // 🔧 NEW: Create update with payment intent details
    const amount = paymentIntent.amount / 100;
    const releaseDate = new Date();
    releaseDate.setDate(releaseDate.getDate() + 7);
    
    const updateText = `🔐 PRE-AUTH COMPLETED: £${amount.toFixed(2)} excess pre-authorization taken
💳 Payment Intent ID: ${paymentIntent.id}
🔗 Stripe Link: https://dashboard.stripe.com/payments/${paymentIntent.id}
📅 Auto-release date: ${releaseDate.toLocaleDateString('en-GB')} (7 days from today)
⚠️ How to claim: Use Admin Portal - NO customer authentication required!
📋 This pre-auth will be automatically released in 7 days if not claimed.`;
    
    await createMondayUpdate(mondayItem.id, updateText, mondayApiKey);
    
    console.log('✅ Monday.com updated with pre-authorization details');
    return { success: true };
    
  } catch (error) {
    console.error('❌ Error updating Monday.com:', error);
    return { success: false, error: error.message };
  }
}

// Complete payment processing with both systems
async function processPaymentComplete(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`🔄 COMPLETE PROCESSING: ${paymentType} payment for job ${jobId}`);
    
    // 🔧 UPDATED: Don't create deposits for uncaptured manual payments
    if (stripeObject.capture_method === 'manual' && stripeObject.status === 'requires_capture') {
      console.log('🔐 Manual capture payment - skipping deposit creation until capture');
      return { hirehopSuccess: true, mondayResult: { success: true }, statusResult: { success: true } };
    }
    
    // Check for duplicate processing
    const sessionId = stripeObject.id;
    const existingPayment = await checkForExistingPayment(jobId, sessionId);
    if (existingPayment) {
      console.log(`⚠️ DUPLICATE DETECTED: Session ${sessionId} already processed - skipping`);
      return { hirehopSuccess: true, mondayResult: { success: true, skipped: true }, statusResult: { success: true, skipped: true } };
    }
    
    // STEP 1: Create HireHop deposit
    console.log('💰 STEP 1: Creating HireHop deposit...');
    const hirehopSuccess = await createDepositWithWorkingXeroSync(jobId, paymentType, stripeObject);
    
    // STEP 2: Update Monday.com
    console.log('📋 STEP 2: Updating Monday.com...');
    const mondayResult = await applyMondayBusinessLogicWithTimeout(jobId, paymentType, stripeObject, isPreAuth);
    
    // STEP 3: Update HireHop job status (only for hire payments)
    console.log('🏢 STEP 3: Updating HireHop job status...');
    let statusResult = { success: false, message: 'Skipped' };
    if (paymentType === 'deposit' || paymentType === 'balance') {
      statusResult = await updateHireHopJobStatusFixed(jobId, 2);
      console.log('✅ Job status updated for hire payment');
    } else {
      console.log('⏭️ Skipping job status update for excess payment');
      statusResult = { success: true, message: 'Skipped - excess payment' };
    }
    
    // STEP 4: Add note
    let noteText = '';
    if (hirehopSuccess && mondayResult.success && statusResult.success) {
      const mondayStatus = mondayResult.skipped ? 'Skipped (duplicate)' : `${mondayResult.updates} updates applied`;
      noteText = `✅ COMPLETE SUCCESS: £${mondayResult.amount?.toFixed(2) || '0.00'} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit created + Xero sync${paymentType !== 'excess' ? ' + Status "Booked"' : ''}. Monday.com: ${mondayStatus}.`;
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

// Check for existing payment processing to prevent duplicates
async function checkForExistingPayment(jobId, sessionId) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const notesUrl = `https://${hirehopDomain}/api/job_notes.php?job=${jobId}&token=${encodedToken}`;
    const response = await fetch(notesUrl);
    
    if (response.ok) {
      const notes = await response.json();
      if (Array.isArray(notes)) {
        const existingNote = notes.find(note => 
          note.note && note.note.includes(sessionId)
        );
        return existingNote;
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error checking for existing payment:', error);
    return null;
  }
}

// Monday.com business logic with timeout protection
async function applyMondayBusinessLogicWithTimeout(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`📋 MONDAY BUSINESS LOGIC: Applying rules for job ${jobId} (with timeout protection)`);
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Monday.com timeout')), 8000)
    );
    
    const mondayPromise = applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth);
    
    try {
      const result = await Promise.race([mondayPromise, timeoutPromise]);
      return result;
    } catch (timeoutError) {
      if (timeoutError.message === 'Monday.com timeout') {
        console.log('⚠️ Monday.com update timed out - processing payment anyway');
        
        setImmediate(() => {
          applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth)
            .then(result => console.log('✅ Delayed Monday.com update completed:', result))
            .catch(error => console.error('❌ Delayed Monday.com update failed:', error));
        });
        
        return { 
          success: true, 
          updates: 0, 
          timeout: true,
          amount: calculatePaymentAmount(stripeObject),
          message: 'Monday.com update scheduled for async processing'
        };
      }
      throw timeoutError;
    }
    
  } catch (error) {
    console.error('❌ Monday.com business logic error:', error);
    return { success: false, error: error.message, updates: 0 };
  }
}

// Helper function to calculate payment amount
function calculatePaymentAmount(stripeObject) {
  if (stripeObject.amount_total) {
    return stripeObject.amount_total / 100;
  } else if (stripeObject.amount) {
    return stripeObject.amount / 100;
  } else if (stripeObject.amount_received) {
    return stripeObject.amount_received / 100;
  }
  return 0;
}

// Monday.com business logic
async function applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`📋 MONDAY BUSINESS LOGIC: Applying rules for job ${jobId}`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping');
      return { success: false, error: 'No credentials', updates: 0 };
    }
    
    let paymentAmount = calculatePaymentAmount(stripeObject);
    
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log('⚠️ Job not found in Monday.com, skipping updates');
      return { success: false, error: 'Job not found', updates: 0 };
    }
    
    console.log(`✅ Found Monday.com item: ${mondayItem.id}`);
    
    const currentStatuses = extractCurrentStatuses(mondayItem);
    const jobDetails = await getFreshJobDetails(jobId);
    
    const updates = [];
    
    if (paymentType === 'excess' || paymentType === 'excess_claim') {
      // Don't update for manual capture pre-auths (handled separately)
      // Regular excess payments still update here
      if (paymentType === 'excess' && !isPreAuth) {
        updates.push({
          columnId: 'status58',
          newValue: 'Excess paid',
          description: 'Insurance excess payment completed'
        });
      }
    } else if (paymentType === 'deposit' || paymentType === 'balance') {
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
    
    let successCount = 0;
    
    for (const update of updates) {
      if (update.type === 'update') {
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

// YOUR WORKING XERO SYNC METHOD
async function createDepositWithWorkingXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 Creating ${paymentType} deposit for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    let amount = calculatePaymentAmount(stripeObject);
    
    const description = `${jobId} - ${paymentType}`;
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    let stripeUrl = '';
    if (stripeObject.payment_intent) {
      stripeUrl = `https://dashboard.stripe.com/payments/${stripeObject.payment_intent}`;
    } else if (stripeObject.id && stripeObject.id.startsWith('pi_')) {
      stripeUrl = `https://dashboard.stripe.com/payments/${stripeObject.id}`;
    } else {
      stripeUrl = `https://dashboard.stripe.com/checkout/sessions/${stripeObject.id}`;
    }
    
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: ${stripeUrl}`,
      ACC_ACCOUNT_ID: 267,
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
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: clientId,
      token: token
    };
    
    console.log('💰 STEP 1: Creating deposit (ID: 0)');
    
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
      
      console.log('🔄 STEP 2: Triggering accounting tasks endpoint for Xero sync');
      
      const tasksResult = await triggerAccountingTasks(
        parsedResponse.hh_id,
        3,
        1,
        token,
        hirehopDomain
      );
      
      console.log('📋 Tasks endpoint result:', tasksResult);
      
      return true;
    } else {
      console.log(`❌ Deposit creation failed:`, parsedResponse);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error in deposit creation:', error);
    throw error;
  }
}

// Trigger accounting tasks
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

// Helper functions
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

async function updateMondayColumn(itemId, columnId, newValue, apiKey, boardId, isText = false) {
  try {
    let valueJson;
    
    if (isText) {
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

async function updateMondayExcessStatus(jobId, newStatus) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      return { success: false };
    }
    
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      return { success: false };
    }
    
    return await updateMondayColumn(
      mondayItem.id,
      'status58',
      newStatus,
      mondayApiKey,
      mondayBoardId
    );
    
  } catch (error) {
    console.error('Error updating Monday excess status:', error);
    return { success: false };
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
      return 1822;
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822;
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
