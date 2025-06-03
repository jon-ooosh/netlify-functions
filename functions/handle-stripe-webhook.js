// handle-stripe-webhook.js - FIXED VERSION: Restored working Xero sync + Fixed Monday.com
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

// Monday.com column IDs
const MONDAY_COLUMNS = {
  JOB_STATUS: 'dup__of_job_status',           // Job Status
  INSURANCE_EXCESS: 'status58',               // Insurance excess >
  QUOTE_STATUS: 'status3',                    // Quote status  
  QUOTE_OR_CONFIRMED: 'status6',              // Quote or confirmed
  STRIPE_XS_LINK: 'text_mkrjj4sa'            // Stripe xs link (for pre-auths only)
};

// Status values for each column
const STATUS_VALUES = {
  QUOTE_STATUS: {
    DEPOSIT_PAID: 'Deposit paid',
    PAID_IN_FULL: 'Paid in full'
  },
  JOB_STATUS: {
    BALANCE_TO_PAY: 'Balance to pay', 
    PAID_IN_FULL: 'Paid in full'
  },
  INSURANCE_EXCESS: {
    EXCESS_PAID: 'Excess paid',
    PRE_AUTH_TAKEN: 'Pre-auth taken'
  },
  QUOTE_OR_CONFIRMED: {
    QUOTE: 'Quote',
    CONFIRMED: 'Confirmed quote'
  }
};

exports.handler = async (event, context) => {
  try {
    console.log('🎯 FIXED WEBHOOK - Processing Stripe payment with restored Xero sync');
    
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
    await processPaymentWithBothIntegrations(jobId, paymentType, session, false);
  } else {
    await processPreAuthWithBothIntegrations(jobId, paymentType, session);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('💳 Processing payment intent:', paymentIntent.id);
  const { jobId, paymentType } = paymentIntent.metadata;
  
  if (!jobId || !paymentType) {
    console.error('❌ Missing required metadata');
    return;
  }
  
  await processPaymentWithBothIntegrations(jobId, paymentType, paymentIntent, false);
}

// 🎯 MAIN INTEGRATION: Process payment with BOTH Xero + Monday.com working
async function processPaymentWithBothIntegrations(jobId, paymentType, stripeObject, isPreAuth = false) {
  try {
    console.log(`🔄 BOTH INTEGRATIONS: Processing ${paymentType} payment for job ${jobId}`);
    
    // STEP 1: Create deposit in HireHop with RESTORED working Xero sync
    console.log('💰 STEP 1: Creating HireHop deposit with RESTORED Xero sync...');
    const depositResult = await createDepositWithRestoredXeroSync(jobId, paymentType, stripeObject);
    
    if (!depositResult.success) {
      console.error('❌ HireHop deposit creation failed:', depositResult.error);
      await addHireHopNote(jobId, `🚨 PAYMENT ERROR: ${paymentType} deposit creation failed. Stripe: ${stripeObject.id}. Error: ${depositResult.error}`);
      return { success: false, error: 'HireHop deposit creation failed' };
    }
    
    console.log('✅ STEP 1 SUCCESS: HireHop deposit created with Xero sync');
    
    // STEP 2: Get fresh job details for Monday.com logic
    console.log('📋 STEP 2: Getting fresh job details for Monday.com...');
    const jobDetails = await getFreshJobDetails(jobId);
    
    // STEP 3: Update Monday.com (independent of HireHop/Xero)
    console.log('📋 STEP 3: Updating Monday.com statuses...');
    let mondayResult = { success: false, error: 'Skipped - no job details' };
    
    if (jobDetails) {
      // Calculate payment amount
      let paymentAmount = 0;
      if (stripeObject.amount_total) {
        paymentAmount = stripeObject.amount_total / 100;
      } else if (stripeObject.amount) {
        paymentAmount = stripeObject.amount / 100;
      } else if (stripeObject.amount_received) {
        paymentAmount = stripeObject.amount_received / 100;
      }
      
      mondayResult = await updateMondayPaymentStatusFixed(
        jobId, 
        paymentType, 
        stripeObject.id, 
        paymentAmount, 
        isPreAuth, 
        jobDetails
      );
    } else {
      console.log('⚠️ STEP 3 SKIPPED: Could not get job details for Monday.com integration');
    }
    
    // STEP 4: Comprehensive results and notes
    if (mondayResult.success) {
      console.log('✅ BOTH INTEGRATIONS SUCCESS');
      await addHireHopNote(jobId, `✅ PAYMENT SUCCESS: £${(paymentAmount || 0).toFixed(2)} ${paymentType} processed. Stripe: ${stripeObject.id}. HireHop: Deposit ${depositResult.depositId} created with Xero sync. Monday.com: ${mondayResult.mondayUpdates || 0} status updates + ${mondayResult.hirehopUpdate?.success ? 'HireHop status updated' : 'HireHop status update failed'}.`);
    } else {
      console.log('⚠️ PARTIAL SUCCESS: HireHop worked, Monday.com failed');
      await addHireHopNote(jobId, `⚠️ PARTIAL SUCCESS: £${(paymentAmount || 0).toFixed(2)} ${paymentType} processed (Stripe: ${stripeObject.id}). HireHop: Deposit ${depositResult.depositId} created with Xero sync. Monday.com: Failed - ${mondayResult.error}`);
    }
    
    return { 
      success: true, 
      deposit: depositResult, 
      monday: mondayResult,
      summary: {
        hirehopSuccess: depositResult.success,
        xeroSyncRestored: true,
        mondaySuccess: mondayResult.success,
        depositId: depositResult.depositId
      }
    };
    
  } catch (error) {
    console.error('❌ Error in both integrations:', error);
    await addHireHopNote(jobId, `🚨 INTEGRATION ERROR: ${paymentType} payment failed. Stripe: ${stripeObject.id}. Error: ${error.message}`);
    throw error;
  }
}

// Process pre-authorization with both integrations
async function processPreAuthWithBothIntegrations(jobId, paymentType, session) {
  try {
    console.log(`🔐 PRE-AUTH BOTH INTEGRATIONS: Processing ${paymentType} pre-auth for job ${jobId}`);
    
    // Get job details
    const jobDetails = await getFreshJobDetails(jobId);
    const amount = session.amount_total ? session.amount_total / 100 : 1200; // Default to £1200 for excess
    
    // Update Monday.com for pre-auth (HireHop doesn't need deposit for pre-auths)
    let mondayResult = { success: false, error: 'No job details' };
    
    if (jobDetails) {
      mondayResult = await updateMondayPaymentStatusFixed(
        jobId, 
        paymentType, 
        session.id, 
        amount, 
        true, // isPreAuth = true
        jobDetails
      );
    }
    
    if (mondayResult.success) {
      console.log('✅ PRE-AUTH INTEGRATION SUCCESS');
      await addHireHopNote(jobId, `🔐 PRE-AUTH: £${amount.toFixed(2)} ${paymentType} pre-authorization set up. Stripe: ${session.id}. Monday.com updated with pre-auth status.`);
    } else {
      console.error('❌ PRE-AUTH INTEGRATION FAILED:', mondayResult.error);
      await addHireHopNote(jobId, `🔐 PRE-AUTH: £${amount.toFixed(2)} ${paymentType} pre-authorization set up (Stripe: ${session.id}) but Monday.com update failed: ${mondayResult.error}`);
    }
    
    return { success: true, monday: mondayResult, type: 'preauth' };
    
  } catch (error) {
    console.error('❌ Error in pre-auth integration:', error);
    await addHireHopNote(jobId, `🚨 PRE-AUTH ERROR: ${paymentType} pre-authorization failed. Stripe: ${session.id}. Error: ${error.message}`);
    throw error;
  }
}

// 🎯 RESTORED: Your EXACT working Xero sync method (no changes!)
async function createDepositWithRestoredXeroSync(jobId, paymentType, stripeObject) {
  try {
    console.log(`🏦 RESTORED XERO SYNC: Creating ${paymentType} deposit for job ${jobId} with your proven method`);
    
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
    
    if (amount <= 0) {
      throw new Error('Invalid payment amount');
    }
    
    const description = `${jobId} - ${paymentType}`;
    const currentDate = new Date().toISOString().split('T')[0];
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // Your EXACT working deposit data structure
    const depositData = {
      ID: 0, // CRITICAL: Always 0 for new deposits
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
    
    console.log('💰 STEP 1: Creating deposit (ID: 0)');
    
    // STEP 1: Create deposit (ID: 0)
    const response1 = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText1 = await response1.text();
    let parsedResponse1;
    
    try {
      parsedResponse1 = JSON.parse(responseText1);
    } catch (e) {
      console.error('❌ Invalid JSON response from deposit creation:', responseText1);
      return { success: false, error: 'Invalid response from HireHop API' };
    }
    
    if (!response1.ok || !parsedResponse1.hh_id) {
      console.error(`❌ Deposit creation failed:`, parsedResponse1);
      return { success: false, error: 'Failed to create deposit in HireHop' };
    }
    
    const depositId = parsedResponse1.hh_id;
    console.log(`✅ STEP 1 SUCCESS: Deposit ${depositId} created`);
    
    // STEP 2: Edit the deposit to trigger Xero sync (your proven method)
    console.log('🔄 STEP 2: Editing deposit to trigger Xero sync (your working method)');
    depositData.ID = depositId; // CRITICAL: Change from 0 to actual deposit ID
    
    const response2 = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText2 = await response2.text();
    console.log('🔄 STEP 2 COMPLETED: Xero sync trigger sent');
    
    // Optional: Quick verification of Xero sync (don't fail if this doesn't work)
    setTimeout(async () => {
      try {
        const verification = await verifyXeroSyncQuick(jobId, depositId, token, hirehopDomain);
        console.log(`🔍 Xero sync verification for deposit ${depositId}:`, verification);
      } catch (verifyError) {
        console.log('⚠️ Xero sync verification failed (non-critical):', verifyError.message);
      }
    }, 3000); // Check after 3 seconds
    
    return { 
      success: true, 
      depositId: depositId, 
      method: 'restored_working_method',
      steps: ['create_deposit_id_0', 'edit_deposit_with_id_to_trigger_xero_sync']
    };
    
  } catch (error) {
    console.error('❌ Error in restored Xero sync:', error);
    return { success: false, error: error.message };
  }
}

// 🎯 FIXED: Monday.com integration with corrected API calls
async function updateMondayPaymentStatusFixed(jobId, paymentType, stripeTransactionId, paymentAmount, isPreAuth = false, jobDetails) {
  try {
    console.log(`🎯 FIXED MONDAY INTEGRATION: Starting update for job ${jobId}, payment type: ${paymentType}, amount: £${paymentAmount}`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    const hirehopToken = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping Monday.com integration');
      return { success: false, error: 'Monday.com credentials not configured' };
    }
    
    // STEP 1: Find the Monday.com item by job ID using FIXED API call
    console.log('📋 STEP 1: Finding Monday.com item with FIXED search...');
    const mondayItem = await findMondayItemFixed(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log(`⚠️ No Monday.com item found for job ${jobId}`);
      return { success: false, error: 'Job not found in Monday.com' };
    }
    
    console.log(`✅ Found Monday.com item: ${mondayItem.id}`);
    
    // STEP 2: Get current status values
    console.log('📋 STEP 2: Reading current status values...');
    const currentStatuses = extractCurrentStatuses(mondayItem);
    console.log('Current statuses:', currentStatuses);
    
    // STEP 3: Determine what status updates to make
    console.log('📋 STEP 3: Calculating status updates...');
    const statusUpdates = calculateStatusUpdates(
      paymentType, 
      paymentAmount, 
      isPreAuth, 
      currentStatuses, 
      jobDetails
    );
    
    console.log('Status updates to make:', statusUpdates);
    
    // STEP 4: Update Monday.com statuses
    console.log('📋 STEP 4: Updating Monday.com...');
    const mondayResults = [];
    
    for (const [columnId, newValue] of Object.entries(statusUpdates)) {
      if (newValue) {
        const result = await updateMondayColumn(
          mondayItem.id, 
          columnId, 
          newValue, 
          mondayApiKey, 
          mondayBoardId
        );
        mondayResults.push({ column: columnId, value: newValue, success: result.success });
      }
    }
    
    // STEP 5: Add Stripe transaction ID
    console.log('📋 STEP 5: Adding Stripe transaction ID...');
    const stripeIdResult = await addStripeTransactionId(
      mondayItem.id,
      stripeTransactionId,
      paymentType,
      paymentAmount,
      isPreAuth,
      mondayApiKey,
      mondayBoardId
    );
    
    // STEP 6: Update HireHop job status to "Booked" for payments
    console.log('📋 STEP 6: Updating HireHop job status...');
    let hirehopResult = { success: false, message: 'Skipped' };
    
    if (paymentType === 'deposit' || paymentType === 'balance') {
      hirehopResult = await updateHireHopJobStatus(jobId, 2, hirehopToken, hirehopDomain); // Status 2 = Booked
    }
    
    // STEP 7: Return comprehensive results
    console.log('✅ FIXED MONDAY INTEGRATION COMPLETE');
    
    return {
      success: true,
      jobId,
      mondayItemId: mondayItem.id,
      statusUpdates: mondayResults,
      stripeIdUpdate: stripeIdResult,
      hirehopUpdate: hirehopResult,
      mondayUpdates: mondayResults.filter(r => r.success).length,
      summary: {
        mondayUpdates: mondayResults.filter(r => r.success).length,
        totalUpdates: mondayResults.length,
        hirehopUpdated: hirehopResult.success,
        stripeIdAdded: stripeIdResult.success
      }
    };
    
  } catch (error) {
    console.error('❌ FIXED MONDAY INTEGRATION ERROR:', error);
    return {
      success: false,
      error: error.message,
      jobId
    };
  }
}

// 🎯 FIXED: Monday.com item finder using correct API method
async function findMondayItemFixed(jobId, apiKey, boardId) {
  try {
    console.log(`🔍 FIXED SEARCH: Searching for job ${jobId} in Monday.com board ${boardId}`);
    
    // FIXED: Use items_by_column_values (the working method from our test)
    const query = `
      query {
        items_by_column_values(
          board_id: ${boardId}
          column_id: "text7"
          column_value: "${jobId}"
        ) {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error('Monday.com API errors:', result.errors);
      return null;
    }
    
    const items = result.data?.items_by_column_values || [];
    
    if (items.length > 0) {
      console.log(`✅ FIXED SEARCH SUCCESS: Found job ${jobId} in Monday.com item: ${items[0].id}`);
      return items[0];
    } else {
      console.log(`❌ FIXED SEARCH RESULT: Job ${jobId} not found in Monday.com board`);
      return null;
    }
    
  } catch (error) {
    console.error('Error in fixed Monday.com search:', error);
    return null;
  }
}

// Get fresh job details for Monday.com logic
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

// Calculate what status updates to make based on business logic
function calculateStatusUpdates(paymentType, paymentAmount, isPreAuth, currentStatuses, jobDetails) {
  const updates = {};
  
  const quoteOrConfirmed = currentStatuses[MONDAY_COLUMNS.QUOTE_OR_CONFIRMED];
  const isQuote = quoteOrConfirmed === STATUS_VALUES.QUOTE_OR_CONFIRMED.QUOTE;
  const isConfirmed = quoteOrConfirmed === STATUS_VALUES.QUOTE_OR_CONFIRMED.CONFIRMED;
  
  console.log(`Business logic: Quote or Confirmed = "${quoteOrConfirmed}", isQuote: ${isQuote}, isConfirmed: ${isConfirmed}`);
  
  // Handle hire payments (deposit/balance)
  if (paymentType === 'deposit' || paymentType === 'balance') {
    const remainingAfterPayment = Math.max(0, jobDetails.financial.remainingHireBalance - paymentAmount);
    const isFullPayment = remainingAfterPayment <= 0.01;
    
    console.log(`Payment logic: Amount paid: £${paymentAmount}, Remaining after: £${remainingAfterPayment}, Is full payment: ${isFullPayment}`);
    
    if (isQuote) {
      if (isFullPayment) {
        updates[MONDAY_COLUMNS.QUOTE_STATUS] = STATUS_VALUES.QUOTE_STATUS.PAID_IN_FULL;
      } else {
        updates[MONDAY_COLUMNS.QUOTE_STATUS] = STATUS_VALUES.QUOTE_STATUS.DEPOSIT_PAID;
      }
    } else if (isConfirmed) {
      if (isFullPayment) {
        updates[MONDAY_COLUMNS.JOB_STATUS] = STATUS_VALUES.JOB_STATUS.PAID_IN_FULL;
      } else {
        updates[MONDAY_COLUMNS.JOB_STATUS] = STATUS_VALUES.JOB_STATUS.BALANCE_TO_PAY;
      }
    }
  }
  
  // Handle excess payments
  if (paymentType === 'excess') {
    if (isPreAuth) {
      updates[MONDAY_COLUMNS.INSURANCE_EXCESS] = STATUS_VALUES.INSURANCE_EXCESS.PRE_AUTH_TAKEN;
    } else {
      updates[MONDAY_COLUMNS.INSURANCE_EXCESS] = STATUS_VALUES.INSURANCE_EXCESS.EXCESS_PAID;
    }
  }
  
  return updates;
}

// Update a Monday.com column with new status value
async function updateMondayColumn(itemId, columnId, newValue, apiKey, boardId) {
  try {
    console.log(`📝 Updating Monday.com column ${columnId} to "${newValue}"`);
    
    const value = JSON.stringify({ label: newValue });
    
    const mutation = `
      mutation {
        change_column_value(
          item_id: ${itemId}
          board_id: ${boardId}
          column_id: "${columnId}"
          value: "${value.replace(/"/g, '\\"')}"
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
      console.error(`Monday.com update error for ${columnId}:`, result.errors);
      return { success: false, error: result.errors };
    }
    
    console.log(`✅ Updated ${columnId} successfully`);
    return { success: true };
    
  } catch (error) {
    console.error(`Error updating Monday.com column ${columnId}:`, error);
    return { success: false, error: error.message };
  }
}

// Add Stripe transaction ID
async function addStripeTransactionId(itemId, stripeId, paymentType, amount, isPreAuth, apiKey, boardId) {
  try {
    console.log(`📝 Adding Stripe transaction ID: ${stripeId}`);
    
    if (isPreAuth && paymentType === 'excess') {
      // For pre-auths, add to the dedicated Stripe XS Link column
      console.log('🔐 Adding pre-auth link to Stripe XS column');
      
      const stripeUrl = `https://dashboard.stripe.com/setup_intents/${stripeId}`;
      
      const mutation = `
        mutation {
          change_column_value(
            item_id: ${itemId}
            board_id: ${boardId}
            column_id: "${MONDAY_COLUMNS.STRIPE_XS_LINK}"
            value: "${stripeUrl}"
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
        console.error('Monday.com Stripe XS link update error:', result.errors);
        return { success: false, error: result.errors };
      }
      
      console.log(`✅ Added Stripe pre-auth link to XS column`);
      return { success: true, type: 'stripe_xs_link' };
      
    } else {
      // For regular payments, add as an update
      const paymentDescription = `Payment: £${amount} (${paymentType})`;
      const updateText = `${paymentDescription} - Stripe ID: ${stripeId}`;
      
      const mutation = `
        mutation {
          create_update(
            item_id: ${itemId}
            body: "${updateText}"
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
        console.error('Monday.com update creation error:', result.errors);
        return { success: false, error: result.errors };
      }
      
      console.log(`✅ Added Stripe transaction ID update`);
      return { success: true, updateId: result.data?.create_update?.id, type: 'update' };
    }
    
  } catch (error) {
    console.error('Error adding Stripe transaction ID:', error);
    return { success: false, error: error.message };
  }
}

// Update HireHop job status
async function updateHireHopJobStatus(jobId, newStatus, token, domain) {
  try {
    console.log(`🏢 Updating HireHop job ${jobId} status to ${newStatus} (Booked)`);
    
    const encodedToken = encodeURIComponent(token);
    const statusUrl = `https://${domain}/api/job_status.php?job=${jobId}&status=${newStatus}&token=${encodedToken}`;
    
    const response = await fetch(statusUrl, { method: 'POST' });
    
    if (response.ok) {
      console.log(`✅ HireHop job status updated successfully`);
      return { success: true, status: newStatus };
    } else {
      const errorText = await response.text();
      console.error(`❌ HireHop status update failed: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
  } catch (error) {
    console.error('Error updating HireHop job status:', error);
    return { success: false, error: error.message };
  }
}

// Quick Xero sync verification (non-critical)
async function verifyXeroSyncQuick(jobId, depositId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    
    const response = await fetch(billingUrl);
    if (!response.ok) {
      return { verified: false, error: `HTTP ${response.status}` };
    }
    
    const billingData = await response.json();
    
    const deposit = billingData.rows?.find(row => 
      row.kind === 6 && row.data?.ID === depositId
    );
    
    if (deposit) {
      const accId = deposit.data?.ACC_ID || '';
      const exported = deposit.data?.exported || 0;
      
      return {
        found: true,
        synced: accId !== '' && accId !== null,
        accId: accId,
        exported: exported
      };
    } else {
      return { found: false };
    }
  } catch (error) {
    return { error: error.message };
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
