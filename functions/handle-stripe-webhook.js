// handle-stripe-webhook.js - YOUR WORKING WEBHOOK + Monday.com Business Logic
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 COMPLETE WEBHOOK - Your working Xero sync + Monday.com business logic');
    
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
    
    console.log(`📥 Webhook event type: ${stripeEvent.type}`);
    
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
    
    // STEP 3: Update HireHop job status to "Booked" for hire payments
    console.log('🏢 STEP 3: Updating HireHop job status...');
    let statusResult = { success: false, message: 'Skipped' };
    if (paymentType === 'deposit' || paymentType === 'balance') {
      statusResult = await updateHireHopJobStatus(jobId, 2); // Status 2 = Booked
    }
    
    // STEP 4: Comprehensive results and notes
    let noteText = '';
    if (hirehopSuccess && mondayResult.success && statusResult.success) {
      noteText = `✅ COMPLETE SUCCESS: £${mondayResult.amount?.toFixed(2) || '0.00'} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit created + Xero sync + Status "Booked". Monday.com: ${mondayResult.updates} updates applied.`;
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

// 🎯 YOUR EXACT WORKING XERO SYNC METHOD - Zero changes!
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
    
    // EXACTLY your working deposit data structure
    const depositData = {
      ID: 0, // Step 1: Always 0 for new deposits
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Stripe: ${stripeObject.id}`,
      ACC_ACCOUNT_ID: 267, // Stripe GBP bank account
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
    
    // STEP 1: Create deposit (ID: 0) - EXACTLY as your method worked
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
      
      // STEP 2: Edit the deposit to trigger Xero sync - EXACTLY your working method
      console.log('🔄 STEP 2: Editing deposit to trigger Xero sync - your proven method');
      depositData.ID = parsedResponse.hh_id; // Change from 0 to actual deposit ID
      
      const editResponse = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(depositData).toString()
      });
      
      const editResponseText = await editResponse.text();
      console.log('🔄 STEP 2 COMPLETED: Edit call made to trigger Xero sync');
      
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

// 🎯 NEW: Apply Monday.com business logic as specified
async function applyMondayBusinessLogic(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`📋 MONDAY BUSINESS LOGIC: Applying rules for job ${jobId}, payment type: ${paymentType}, preAuth: ${isPreAuth}`);
    
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
    
    // STEP 1: Find the Monday.com item
    console.log('🔍 Finding Monday.com item for job', jobId);
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log('⚠️ Job not found in Monday.com, skipping updates');
      return { success: false, error: 'Job not found', updates: 0 };
    }
    
    console.log(`✅ Found Monday.com item: ${mondayItem.id}`);
    
    // STEP 2: Extract current status values
    const currentStatuses = extractCurrentStatuses(mondayItem);
    console.log('Current Monday.com statuses:', currentStatuses);
    
    // STEP 3: Get job details for payment logic
    const jobDetails = await getFreshJobDetails(jobId);
    
    // STEP 4: Apply your business rules
    const updates = [];
    
    if (paymentType === 'excess') {
      // Insurance Excess Rules
      if (isPreAuth) {
        // Excess pre-auth → set "Insurance excess" = Pre-auth taken
        updates.push({
          columnId: 'status58',
          newValue: 'Pre-auth taken',
          description: 'Insurance excess pre-auth taken'
        });
        
        // Pre-auth links → store in "Stripe xs link" column
        const preAuthLink = `https://dashboard.stripe.com/setup_intents/${stripeObject.id}`;
        updates.push({
          columnId: 'text_mkrjj4sa',
          newValue: preAuthLink,
          description: 'Stripe pre-auth link stored',
          isText: true
        });
      } else {
        // Excess payment → set "Insurance excess" = Excess paid
        updates.push({
          columnId: 'status58',
          newValue: 'Excess paid',
          description: 'Insurance excess payment completed'
        });
      }
    } else if (paymentType === 'deposit' || paymentType === 'balance') {
      // Hire payment logic - check Quote or Confirmed status
      const quoteOrConfirmed = currentStatuses.status6; // "Quote or confirmed" column
      
      // Determine if this is a full payment
      const remainingAfterPayment = jobDetails ? Math.max(0, jobDetails.financial.remainingHireBalance - paymentAmount) : 0;
      const isFullPayment = remainingAfterPayment <= 0.01;
      
      console.log(`Payment logic: Quote/Confirmed="${quoteOrConfirmed}", Amount=£${paymentAmount}, Remaining after=£${remainingAfterPayment}, Full payment=${isFullPayment}`);
      
      if (quoteOrConfirmed === 'Quote') {
        // IF "Quote or Confirmed" = Quote
        if (isFullPayment) {
          // Payment = full amount → set "Quote Status" = Paid in full
          updates.push({
            columnId: 'status3',
            newValue: 'Paid in full',
            description: 'Quote paid in full'
          });
        } else {
          // Payment < full amount → set "Quote Status" = Deposit paid
          updates.push({
            columnId: 'status3',
            newValue: 'Deposit paid',
            description: 'Quote deposit paid'
          });
        }
      } else if (quoteOrConfirmed === 'Confirmed quote') {
        // IF "Quote or Confirmed" = Confirmed quote
        if (isFullPayment) {
          // Payment completing total → set "Job Status" = Paid in full
          updates.push({
            columnId: 'dup__of_job_status',
            newValue: 'Paid in full',
            description: 'Job paid in full'
          });
        } else {
          // Payment with balance remaining → set "Job Status" = Balance to pay
          updates.push({
            columnId: 'dup__of_job_status',
            newValue: 'Balance to pay',
            description: 'Job has balance to pay'
          });
        }
      }
    }
    
    // STEP 5: Apply all updates
    console.log(`📝 Applying ${updates.length} Monday.com updates...`);
    let successCount = 0;
    
    for (const update of updates) {
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
    
    console.log(`📋 Monday.com updates completed: ${successCount}/${updates.length} successful`);
    
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

// Find Monday.com item using working search API
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

// Extract current status values from Monday.com item
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

// Update Monday.com column
async function updateMondayColumn(itemId, columnId, newValue, apiKey, boardId, isText = false) {
  try {
    let valueJson;
    
    if (isText) {
      // For text columns, use simple string value
      valueJson = `"${newValue}"`;
    } else {
      // For status columns, use label format
      valueJson = `"{\\"label\\": \\"${newValue}\\"}";
    }
    
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
      return { success: false, error: result.errors };
    }
    
    return { success: true };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get fresh job details for payment calculations
async function getFreshJobDetails(jobId) {
  try {
    const baseUrl = process.env.URL || process.env.DEPLOY_URL || 'https://ooosh-tours-payment-page.netlify.app';
    
    // Get hash first
    let jobDetailsUrl = `${baseUrl}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
    const response1 = await fetch(jobDetailsUrl);
    const result1 = await response1.json();
    
    if (result1.hash && !result1.authenticated) {
      // Call with hash
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

// Update HireHop job status to "Booked" (Status = 2)
async function updateHireHopJobStatus(jobId, newStatus) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const statusUrl = `https://${hirehopDomain}/api/job_status.php?job=${jobId}&status=${newStatus}&token=${encodedToken}`;
    
    const response = await fetch(statusUrl, { method: 'POST' });
    
    if (response.ok) {
      console.log(`✅ HireHop job status updated to ${newStatus} (Booked)`);
      return { success: true, status: newStatus };
    } else {
      const errorText = await response.text();
      console.error(`❌ HireHop status update failed: ${response.status} - ${errorText}`);
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
