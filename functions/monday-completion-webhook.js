// functions/monday-completion-webhook.js - Completion status sync
const fetch = require('node-fetch');

// Status mapping for completion column only
const COMPLETION_STATUS_MAPPING = {
  'dup__of_invoice_emailed_': { // Completed in HireHop? column
    'All done & hire finished': 7  // Completed status in HireHop
  }
};

// HireHop status names for logging
const HIREHOP_STATUS_NAMES = {
  7: 'Completed'
};

exports.handler = async (event, context) => {
  try {
    console.log('🏁 Monday.com completion webhook received');
    
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Preflight call successful' }) };
    }

    // Handle verification challenge
    if (event.httpMethod === 'GET') {
      const challenge = event.queryStringParameters?.challenge;
      if (challenge) {
        console.log('📋 Monday.com webhook verification challenge received:', challenge);
        return { statusCode: 200, headers, body: JSON.stringify({ challenge: challenge }) };
      }
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Parse webhook payload
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (parseError) {
      console.error('❌ Failed to parse webhook payload:', parseError);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON payload' }) };
    }

    console.log('📋 Completion webhook payload:', JSON.stringify(payload, null, 2));

    // Handle verification challenge (POST)
    if (payload.challenge) {
      console.log('📋 Monday.com webhook verification challenge received (POST):', payload.challenge);
      return { statusCode: 200, headers, body: JSON.stringify({ challenge: payload.challenge }) };
    }

    // Validate payload
    if (!payload.event || !payload.event.columnId || !payload.event.value) {
      console.log('⚠️ Webhook payload missing required fields, ignoring');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Webhook received but no action needed' }) };
    }

    const { columnId, value } = payload.event;
    const itemId = payload.event.pulseId || payload.event.itemId;
    
    console.log(`📋 Completion change: columnId=${columnId}, itemId=${itemId}`);

    // Check if this is the completion column
    if (columnId !== 'dup__of_invoice_emailed_') {
      console.log(`⏭️ Column ${columnId} is not the completion column, ignoring`);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Not completion column' }) };
    }

    // Extract status label
    const statusLabel = extractStatusLabel(value);
    
    if (!statusLabel) {
      console.log('⚠️ Could not extract status label, ignoring');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Could not extract status label' }) };
    }

    console.log(`📋 Completion status change: "${statusLabel}"`);

    // Check if this is the completion status we care about
    if (statusLabel !== 'All done & hire finished') {
      console.log(`⏭️ Status "${statusLabel}" is not completion status, ignoring`);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Not completion status' }) };
    }

    // Get job ID from Monday item
    const jobId = await getJobIdFromMondayItem(itemId);
    if (!jobId) {
      console.error('❌ Could not find job ID for Monday.com item:', itemId);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Job ID not found' }) };
    }

    console.log(`🏁 Setting job ${jobId} to Completed status`);

    // Update HireHop status to Completed (7)
    const updateResult = await updateHireHopJobStatus(jobId, 11);

    if (updateResult.success) {
      console.log(`✅ Successfully set job ${jobId} to Completed status`);
      
      // Add note to HireHop
      await addHireHopNote(jobId, '🏁 Job marked as Completed - synced from Monday.com completion status');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          jobId: jobId,
          mondayStatus: statusLabel,
          hireHopStatus: 7,
          statusName: 'Completed'
        })
      };
    } else {
      console.error(`❌ Failed to update job ${jobId}:`, updateResult.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to update HireHop status', details: updateResult.error })
      };
    }

  } catch (error) {
    console.error('❌ Completion webhook error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

// Extract status label from Monday.com value
function extractStatusLabel(value) {
  console.log('🔍 Extracting status from:', JSON.stringify(value, null, 2));
  
  if (typeof value === 'string') {
    return value;
  }
  
  if (value && typeof value === 'object') {
    if (value.label && value.label.text) {
      return value.label.text;
    } else if (value.label && typeof value.label === 'string') {
      return value.label;
    } else if (value.text) {
      return value.text;
    } else if (value.name) {
      return value.name;
    }
  }

  // Try JSON parsing if it's a stringified object
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed.label && parsed.label.text) {
        return parsed.label.text;
      } else if (parsed.text) {
        return parsed.text;
      }
    } catch (e) {
      // Not JSON, return null
    }
  }
  
  return null;
}

// Get job ID from Monday.com item
async function getJobIdFromMondayItem(itemId) {
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
    const items = result.data?.items || [];
    if (items.length === 0) return null;

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
