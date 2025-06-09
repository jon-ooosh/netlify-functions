// functions/monday-webhook.js
// Receives webhooks from Monday.com and syncs status changes to HireHop

const fetch = require('node-fetch');

// Status mapping: Monday.com -> HireHop
const STATUS_MAPPING = {
  'status3': { // Quote Status column
    'No Dice': 10,              // Not Interested
    'Held pending deposit': 1,   // Provisional  
    'Confirmed': 2,             // Booked
    'Deposit paid': 2,          // Booked
    'Paid in full': 2           // Booked
  }
};

// Reverse mapping for logging
const HIREHOP_STATUS_NAMES = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked', 
  7: 'Completed',
  9: 'Cancelled',
  10: 'Not Interested'
};

exports.handler = async (event, context) => {
  try {
    console.log('🔄 Monday.com webhook received');
    
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

    console.log('📋 Monday.com webhook payload:', JSON.stringify(payload, null, 2));

    // Validate webhook payload structure
    if (!payload.event || !payload.event.columnId || !payload.event.value) {
      console.log('⚠️ Webhook payload missing required fields, ignoring');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Webhook received but no action needed' })
      };
    }

    const { columnId, value, itemId, boardId } = payload.event;

    // Check if this is a status column we care about
    if (!STATUS_MAPPING[columnId]) {
      console.log(`⏭️ Column ${columnId} not in our sync mapping, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored' })
      };
    }

    // Extract the status label from Monday.com value
    let statusLabel = null;
    if (typeof value === 'string') {
      statusLabel = value;
    } else if (value && value.label) {
      statusLabel = value.label;
    } else if (value && value.text) {
      statusLabel = value.text;
    }

    if (!statusLabel) {
      console.log('⚠️ Could not extract status label from value:', value);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Could not extract status label' })
      };
    }

    console.log(`📋 Status change detected: Column ${columnId} -> "${statusLabel}"`);

    // Check if we have a mapping for this status
    const hireHopStatus = STATUS_MAPPING[columnId][statusLabel];
    if (hireHopStatus === undefined) {
      console.log(`⏭️ Status "${statusLabel}" not in our mapping for column ${columnId}, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Status not mapped' })
      };
    }

    // Get the job ID from Monday.com item
    const jobId = await getJobIdFromMondayItem(itemId, boardId);
    if (!jobId) {
      console.error('❌ Could not find job ID for Monday.com item:', itemId);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID not found' })
      };
    }

    console.log(`🎯 Syncing job ${jobId}: Monday "${statusLabel}" -> HireHop status ${hireHopStatus} (${HIREHOP_STATUS_NAMES[hireHopStatus]})`);

    // Update HireHop status
    const updateResult = await updateHireHopJobStatus(jobId, hireHopStatus);

    if (updateResult.success) {
      console.log(`✅ Successfully updated HireHop job ${jobId} to status ${hireHopStatus}`);
      
      // Add a note to HireHop about the sync
      await addHireHopNote(jobId, 
        `📋 Status synced from Monday.com: "${statusLabel}" -> ${HIREHOP_STATUS_NAMES[hireHopStatus]}`
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          jobId: jobId,
          mondayStatus: statusLabel,
          hireHopStatus: hireHopStatus,
          statusName: HIREHOP_STATUS_NAMES[hireHopStatus]
        })
      };
    } else {
      console.error(`❌ Failed to update HireHop job ${jobId}:`, updateResult.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to update HireHop status',
          details: updateResult.error
        })
      };
    }

  } catch (error) {
    console.error('❌ Monday.com webhook error:', error);
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

// Get job ID from Monday.com item
async function getJobIdFromMondayItem(itemId, boardId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    if (!mondayApiKey) {
      throw new Error('Monday.com API key not configured');
    }

    const query = `
      query {
        items(ids: [${itemId}]) {
          column_values(ids: ["text7"]) {
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
        'Authorization': mondayApiKey,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({ query })
    });

    const result = await response.json();

    if (result.errors) {
      console.error('Monday.com API errors:', result.errors);
      return null;
    }

    const items = result.data?.items || [];
    if (items.length === 0) {
      return null;
    }

    const jobIdColumn = items[0].column_values?.[0];
    return jobIdColumn?.text || jobIdColumn?.value || null;

  } catch (error) {
    console.error('Error getting job ID from Monday.com:', error);
    return null;
  }
}

// Update HireHop job status
async function updateHireHopJobStatus(jobId, newStatus) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';

    if (!token) {
      throw new Error('HireHop API token not configured');
    }

    const statusData = {
      job: jobId,
      status: newStatus,
      no_webhook: 1, // Prevent infinite loop
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
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

  } catch (error) {
    console.error('Error updating HireHop job status:', error);
    return { success: false, error: error.message };
  }
}

// Add note to HireHop job
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);

    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);

    return response.ok;
  } catch (error) {
    console.error('❌ Error adding HireHop note:', error);
    return false;
  }
}
