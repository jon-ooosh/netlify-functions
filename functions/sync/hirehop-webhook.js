// functions/hirehop-webhook.js
// Receives webhooks from HireHop and syncs status changes to Monday.com

const fetch = require('node-fetch');

// Status mapping: HireHop -> Monday.com
const STATUS_MAPPING = {
  10: 'No Dice',              // Not Interested -> No Dice
  1: 'Held pending deposit',  // Provisional -> Held pending deposit
  2: 'Confirmed',             // Booked -> Confirmed
  // Note: We map Booked to "Confirmed" rather than "Deposit paid" or "Paid in full"
  // because we don't know payment status from HireHop status alone
};

// HireHop status names for logging
const HIREHOP_STATUS_NAMES = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked',
  3: 'Prepped',
  4: 'Part Dispatched',
  5: 'Dispatched',
  6: 'Returned Incomplete',
  7: 'Completed',
  8: 'Requires Attention',
  9: 'Cancelled',
  10: 'Not Interested'
};

exports.handler = async (event, context) => {
  try {
    console.log('🔄 HireHop webhook received');
    
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Preflight call successful' })
      };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    // Parse webhook payload
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (parseError) {
      console.error('❌ Failed to parse webhook payload:', parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON payload' })
      };
    }

    console.log('📋 HireHop webhook payload:', JSON.stringify(payload, null, 2));

    // Validate webhook payload structure
    if (!payload.event || !payload.data) {
      console.log('⚠️ Webhook payload missing required fields, ignoring');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Webhook received but no action needed' })
      };
    }

    // Check if this is a job status update event
    if (!payload.event.includes('job.status')) {
      console.log(`⏭️ Event ${payload.event} is not a job status change, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Event not monitored' })
      };
    }

    // Validate export key for security
    const expectedExportKey = process.env.HIREHOP_EXPORT_KEY;
    if (expectedExportKey && payload.export_key !== expectedExportKey) {
      console.error('❌ Invalid export key in webhook');
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Invalid export key' })
      };
    }

    // Extract job data and status change
    const jobData = payload.data;
    const changes = payload.changes;

    if (!jobData || !changes || !changes.STATUS) {
      console.log('⚠️ No status change detected in webhook, ignoring');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No status change detected' })
      };
    }

    const jobId = jobData.ID || jobData.id;
    const oldStatus = parseInt(changes.STATUS.from);
    const newStatus = parseInt(changes.STATUS.to);

    console.log(`📋 HireHop status change: Job ${jobId}, ${oldStatus} -> ${newStatus} (${HIREHOP_STATUS_NAMES[oldStatus]} -> ${HIREHOP_STATUS_NAMES[newStatus]})`);

    // Check if we have a mapping for this new status
    const mondayStatus = STATUS_MAPPING[newStatus];
    if (!mondayStatus) {
      console.log(`⏭️ HireHop status ${newStatus} (${HIREHOP_STATUS_NAMES[newStatus]}) not in our mapping, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Status not mapped' })
      };
    }

    console.log(`🎯 Syncing job ${jobId}: HireHop ${newStatus} (${HIREHOP_STATUS_NAMES[newStatus]}) -> Monday.com "${mondayStatus}"`);

    // Find Monday.com item and update status
    const updateResult = await updateMondayJobStatus(jobId, mondayStatus);

    if (updateResult.success) {
      console.log(`✅ Successfully updated Monday.com job ${jobId} to "${mondayStatus}"`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          jobId: jobId,
          hireHopStatus: newStatus,
          hireHopStatusName: HIREHOP_STATUS_NAMES[newStatus],
          mondayStatus: mondayStatus,
          mondayItemId: updateResult.mondayItemId
        })
      };
    } else {
      console.error(`❌ Failed to update Monday.com job ${jobId}:`, updateResult.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to update Monday.com status',
          details: updateResult.error
        })
      };
    }

  } catch (error) {
    console.error('❌ HireHop webhook error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// Update Monday.com job status
async function updateMondayJobStatus(jobId, newStatus) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;

    if (!mondayApiKey || !mondayBoardId) {
      throw new Error('Monday.com credentials not configured');
    }

    // First, find the Monday.com item by job ID
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    if (!mondayItem) {
      throw new Error(`Monday.com item not found for job ${jobId}`);
    }

    console.log(`📋 Found Monday.com item: ${mondayItem.id}`);

    // Update the Quote Status column (status3)
    const updateResult = await updateMondayColumn(
      mondayItem.id,
      'status3', // Quote Status column
      newStatus,
      mondayApiKey,
      mondayBoardId
    );

    if (updateResult.success) {
      // Add an update to Monday.com about the sync
      await createMondayUpdate(
        mondayItem.id,
        `🔄 Status synced from HireHop: "${newStatus}"`,
        mondayApiKey
      );

      return { 
        success: true, 
        mondayItemId: mondayItem.id 
      };
    } else {
      return { 
        success: false, 
        error: updateResult.error 
      };
    }

  } catch (error) {
    console.error('Error updating Monday.com job status:', error);
    return { success: false, error: error.message };
  }
}

// Find Monday.com item by job ID (reuse existing function pattern)
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

// Update Monday.com column (reuse existing function pattern)
async function updateMondayColumn(itemId, columnId, newValue, apiKey, boardId) {
  try {
    console.log(`📝 Updating Monday.com column ${columnId} to "${newValue}"`);

    const valueJson = `"{\\"label\\": \\"${newValue.replace(/"/g, '\\"')}\\"}"`;

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

// Create Monday.com update (reuse existing function pattern)
async function createMondayUpdate(itemId, updateText, apiKey) {
  try {
    console.log(`📝 Creating Monday.com update for item ${itemId}`);

    const mutation = `
      mutation {
        create_update(
          item_id: ${itemId}
          body: "${updateText.replace(/"/g, '\\"')}"
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
