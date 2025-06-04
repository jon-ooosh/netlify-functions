// Add this function to monday-excess-checker.js

// Check Monday.com updates for pre-auth completion
async function checkMondayPreAuthStatus(jobId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping pre-auth check');
      return { found: false, reason: 'no_credentials' };
    }
    
    console.log(`🔍 Checking Monday.com updates for pre-auth completion on job ${jobId}`);
    
    // First find the Monday.com item
    const query = `
      query {
        items_by_column_values(
          board_id: ${mondayBoardId}
          column_id: "text7"
          column_value: "${jobId}"
        ) {
          id
          name
          updates {
            id
            body
            created_at
            creator {
              name
            }
          }
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error('Monday.com API errors:', result.errors);
      return { found: false, reason: 'api_error', error: result.errors };
    }
    
    const items = result.data?.items_by_column_values || [];
    
    if (items.length === 0) {
      console.log(`📋 No Monday.com item found for job ${jobId}`);
      return { found: false, reason: 'job_not_found' };
    }
    
    const item = items[0];
    console.log(`📋 Found Monday.com item: ${item.id}`);
    
    // Search updates for pre-auth completion
    const updates = item.updates || [];
    let preAuthUpdate = null;
    let setupIntentId = null;
    let preAuthAmount = null;
    
    // Search for the exact string "PRE-AUTH COMPLETED" in updates
    for (const update of updates) {
      if (update.body && update.body.includes('🔐 PRE-AUTH COMPLETED:')) {
        preAuthUpdate = update;
        
        // Extract setup intent ID from the update
        const setupIntentMatch = update.body.match(/Setup Intent ID: (si_[a-zA-Z0-9_]+)/);
        if (setupIntentMatch) {
          setupIntentId = setupIntentMatch[1];
        }
        
        // Extract amount from the update
        const amountMatch = update.body.match(/£([0-9]+\.?[0-9]*)/);
        if (amountMatch) {
          preAuthAmount = parseFloat(amountMatch[1]);
        }
        
        break; // Take the first (most recent) match
      }
    }
    
    if (preAuthUpdate) {
      console.log(`✅ Found pre-auth completion update: ${preAuthUpdate.id}`);
      return {
        found: true,
        preAuthCompleted: true,
        setupIntentId: setupIntentId,
        amount: preAuthAmount || 1200,
        updateId: preAuthUpdate.id,
        createdAt: preAuthUpdate.created_at,
        creator: preAuthUpdate.creator?.name,
        mondayItemId: item.id,
        updateBody: preAuthUpdate.body
      };
    } else {
      console.log(`📋 No pre-auth completion found in updates for job ${jobId}`);
      return {
        found: true,
        preAuthCompleted: false,
        mondayItemId: item.id,
        totalUpdates: updates.length
      };
    }
    
  } catch (error) {
    console.error('Error checking Monday.com pre-auth status:', error);
    return { found: false, reason: 'error', error: error.message };
  }
}

// Updated main function that combines both status and pre-auth checks
async function checkMondayExcessStatus(jobId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping excess status check');
      return { found: false, reason: 'no_credentials' };
    }
    
    console.log(`🔍 Checking Monday.com excess status for job ${jobId}`);
    
    // Find the Monday.com item with both column data and updates
    const query = `
      query {
        items_by_column_values(
          board_id: ${mondayBoardId}
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
          updates {
            id
            body
            created_at
            creator {
              name
            }
          }
        }
      }
    `;
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      console.error('Monday.com API errors:', result.errors);
      return { found: false, reason: 'api_error', error: result.errors };
    }
    
    const items = result.data?.items_by_column_values || [];
    
    if (items.length === 0) {
      console.log(`📋 No Monday.com item found for job ${jobId}`);
      return { found: false, reason: 'job_not_found' };
    }
    
    const item = items[0];
    console.log(`📋 Found Monday.com item: ${item.id}`);
    
    // Extract the insurance excess status from columns
    const excessColumn = item.column_values.find(col => col.id === 'status58'); // Insurance excess >
    const stripeXsColumn = item.column_values.find(col => col.id === 'text_mkrjj4sa'); // Stripe xs link
    
    let excessStatus = null;
    let hasStripeLink = false;
    
    if (excessColumn) {
      try {
        if (excessColumn.text) {
          excessStatus = excessColumn.text;
        } else if (excessColumn.value) {
          const parsed = JSON.parse(excessColumn.value);
          excessStatus = parsed.label || parsed.text || null;
        }
      } catch (e) {
        excessStatus = excessColumn.value;
      }
    }
    
    if (stripeXsColumn && stripeXsColumn.text) {
      hasStripeLink = stripeXsColumn.text.includes('stripe.com');
    }
    
    // Check for pre-auth completion in updates
    const updates = item.updates || [];
    let preAuthUpdate = null;
    let setupIntentId = null;
    let preAuthAmount = null;
    
    for (const update of updates) {
      if (update.body && update.body.includes('🔐 PRE-AUTH COMPLETED:')) {
        preAuthUpdate = update;
        
        // Extract setup intent ID
        const setupIntentMatch = update.body.match(/Setup Intent ID: (si_[a-zA-Z0-9_]+)/);
        if (setupIntentMatch) {
          setupIntentId = setupIntentMatch[1];
        }
        
        // Extract amount
        const amountMatch = update.body.match(/£([0-9]+\.?[0-9]*)/);
        if (amountMatch) {
          preAuthAmount = parseFloat(amountMatch[1]);
        }
        
        break;
      }
    }
    
    console.log(`📋 Monday.com excess status: "${excessStatus}", Has Stripe link: ${hasStripeLink}, Pre-auth update: ${!!preAuthUpdate}`);
    
    // Determine excess payment status with priority to pre-auth updates
    let excessPaid = 0;
    let excessMethod = 'not_required';
    let excessDescription = 'No excess required';
    
    if (preAuthUpdate) {
      // Pre-auth found in updates (most reliable)
      excessPaid = 0; // Pre-auth doesn't count as "paid"
      excessMethod = 'pre-auth_completed';
      excessDescription = 'Pre-authorization completed via Monday.com update';
    } else if (excessStatus === 'Pre-auth taken' || hasStripeLink) {
      // Fallback to column status
      excessPaid = 0;
      excessMethod = 'pre-auth_completed';
      excessDescription = 'Pre-authorization completed via Monday.com column';
    } else if (excessStatus === 'Excess paid') {
      excessPaid = 1200; // Assume £1200 standard excess
      excessMethod = 'completed';
      excessDescription = 'Excess payment completed via Monday.com record';
    } else if (excessStatus === 'Retained from previous hire') {
      excessPaid = 1200;
      excessMethod = 'retained';
      excessDescription = 'Excess retained from previous hire';
    }
    
    return {
      found: true,
      mondayItemId: item.id,
      excessStatus: excessStatus,
      hasStripeLink: hasStripeLink,
      preAuthUpdate: preAuthUpdate ? {
        id: preAuthUpdate.id,
        setupIntentId: setupIntentId,
        amount: preAuthAmount,
        createdAt: preAuthUpdate.created_at,
        creator: preAuthUpdate.creator?.name
      } : null,
      mondayExcessData: {
        paid: excessPaid,
        method: excessMethod,
        description: excessDescription,
        source: preAuthUpdate ? 'monday_update' : 'monday_column'
      }
    };
    
  } catch (error) {
    console.error('Error checking Monday.com excess status:', error);
    return { found: false, reason: 'error', error: error.message };
  }
}

module.exports = {
  checkMondayExcessStatus,
  checkMondayPreAuthStatus
};
