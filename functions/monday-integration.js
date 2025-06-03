// monday-integration.js - Complete Monday.com + HireHop status update system
const fetch = require('node-fetch');

// Monday.com column IDs from your board
const MONDAY_COLUMNS = {
  JOB_STATUS: 'dup__of_job_status',           // Job Status
  INSURANCE_EXCESS: 'status58',               // Insurance excess >
  QUOTE_STATUS: 'status3',                    // Quote status  
  QUOTE_OR_CONFIRMED: 'status6',              // Quote or confirmed
  STRIPE_ID: 'text' // We'll create this for Stripe transaction IDs
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

// Main function to update Monday.com and HireHop after payment
async function updatePaymentStatus(jobId, paymentType, stripeTransactionId, paymentAmount, isPreAuth = false, jobDetails) {
  try {
    console.log(`🎯 MONDAY INTEGRATION: Starting update for job ${jobId}, payment type: ${paymentType}, amount: £${paymentAmount}`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    const hirehopToken = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!mondayApiKey || !mondayBoardId) {
      throw new Error('Monday.com API credentials not configured');
    }
    
    // Step 1: Find the Monday.com item by job ID
    console.log('📋 STEP 1: Finding Monday.com item...');
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log(`⚠️ No Monday.com item found for job ${jobId}`);
      return { success: false, error: 'Job not found in Monday.com' };
    }
    
    console.log(`✅ Found Monday.com item: ${mondayItem.id}`);
    
    // Step 2: Get current status values
    console.log('📋 STEP 2: Reading current status values...');
    const currentStatuses = extractCurrentStatuses(mondayItem);
    console.log('Current statuses:', currentStatuses);
    
    // Step 3: Determine what status updates to make
    console.log('📋 STEP 3: Calculating status updates...');
    const statusUpdates = calculateStatusUpdates(
      paymentType, 
      paymentAmount, 
      isPreAuth, 
      currentStatuses, 
      jobDetails
    );
    
    console.log('Status updates to make:', statusUpdates);
    
    // Step 4: Update Monday.com statuses
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
    
    // Step 5: Add Stripe transaction ID
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
    
    // Step 6: Update HireHop job status to "Booked" for payments
    console.log('📋 STEP 6: Updating HireHop job status...');
    let hirehopResult = { success: false, message: 'Skipped' };
    
    if (paymentType === 'deposit' || paymentType === 'balance') {
      hirehopResult = await updateHireHopJobStatus(jobId, 2, hirehopToken, hirehopDomain); // Status 2 = Booked
    }
    
    // Step 7: Return comprehensive results
    console.log('✅ MONDAY INTEGRATION COMPLETE');
    
    return {
      success: true,
      jobId,
      mondayItemId: mondayItem.id,
      statusUpdates: mondayResults,
      stripeIdUpdate: stripeIdResult,
      hirehopUpdate: hirehopResult,
      summary: {
        mondayUpdates: mondayResults.filter(r => r.success).length,
        totalUpdates: mondayResults.length,
        hirehopUpdated: hirehopResult.success,
        stripeIdAdded: stripeIdResult.success
      }
    };
    
  } catch (error) {
    console.error('❌ MONDAY INTEGRATION ERROR:', error);
    return {
      success: false,
      error: error.message,
      jobId
    };
  }
}

// Find Monday.com item by job ID
async function findMondayItem(jobId, apiKey, boardId) {
  try {
    // We'll search in the Job column - assuming it contains the job ID
    // You may need to adjust the column_id if the job number is stored elsewhere
    const query = `
      query {
        items_by_column_values(
          board_id: ${boardId}
          column_id: "job"
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
    
    // Parse the column value based on type
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
    const isFullPayment = remainingAfterPayment <= 0.01; // Allow for small rounding differences
    
    console.log(`Payment logic: Amount paid: £${paymentAmount}, Remaining after: £${remainingAfterPayment}, Is full payment: ${isFullPayment}`);
    
    if (isQuote) {
      // Quote logic
      if (isFullPayment) {
        updates[MONDAY_COLUMNS.QUOTE_STATUS] = STATUS_VALUES.QUOTE_STATUS.PAID_IN_FULL;
      } else {
        updates[MONDAY_COLUMNS.QUOTE_STATUS] = STATUS_VALUES.QUOTE_STATUS.DEPOSIT_PAID;
      }
    } else if (isConfirmed) {
      // Confirmed quote logic
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
    
    // Create the appropriate value format for Monday.com API
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

// Add Stripe transaction ID as an update to the item
async function addStripeTransactionId(itemId, stripeId, paymentType, amount, isPreAuth, apiKey, boardId) {
  try {
    console.log(`📝 Adding Stripe transaction ID: ${stripeId}`);
    
    const paymentDescription = isPreAuth ? 
      `Pre-auth: £${amount} (${paymentType})` : 
      `Payment: £${amount} (${paymentType})`;
    
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
    return { success: true, updateId: result.data?.create_update?.id };
    
  } catch (error) {
    console.error('Error adding Stripe transaction ID:', error);
    return { success: false, error: error.message };
  }
}

// Update HireHop job status
async function updateHireHopJobStatus(jobId, newStatus, token, domain) {
  try {
    console.log(`🏢 Updating HireHop job ${jobId} status to ${newStatus} (Booked)`);
    
    // Try the job status update endpoint
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

module.exports = {
  updatePaymentStatus,
  MONDAY_COLUMNS,
  STATUS_VALUES
};
