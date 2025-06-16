// functions/monday-webhook.js - More robust webhook with retry logic
const fetch = require('node-fetch');

// Status mapping: Monday.com -> HireHop
const STATUS_MAPPING = {
  'status3': { // Quote Status column
    'Quoted': 0,                // Enquiry
    'No dice': 10,              // Not Interested
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

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffFactor: 2
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

    // Handle Monday.com webhook verification challenge
    if (event.httpMethod === 'GET') {
      const challenge = event.queryStringParameters?.challenge;
      if (challenge) {
        console.log('📋 Monday.com webhook verification challenge received (GET):', challenge);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ challenge: challenge })
        };
      }
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

    // Handle Monday.com webhook verification challenge (POST request)
    if (payload.challenge) {
      console.log('📋 Monday.com webhook verification challenge received (POST):', payload.challenge);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ challenge: payload.challenge })
      };
    }

    // Validate webhook payload structure
    if (!payload.event || !payload.event.columnId || !payload.event.value) {
      console.log('⚠️ Webhook payload missing required fields, ignoring');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Webhook received but no action needed' })
      };
    }

    const { columnId, value, boardId } = payload.event;
    const itemId = payload.event.pulseId || payload.event.itemId;
    
    console.log(`📋 Extracted IDs: itemId=${itemId}, boardId=${boardId}, columnId=${columnId}`);

    // Check if this is a status column we care about
    if (!STATUS_MAPPING[columnId]) {
      console.log(`⏭️ Column ${columnId} not in our sync mapping, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored' })
      };
    }

    // Extract status label with enhanced debugging
    const statusLabel = extractStatusLabel(value);
    
    if (!statusLabel) {
      console.log('⚠️ Could not extract status label from value, returning early');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Could not extract status label',
          debug: {
            valueType: typeof value,
            valueKeys: value ? Object.keys(value) : null,
            rawValue: value
          }
        })
      };
    }

    console.log(`📋 Status change detected: Column ${columnId} -> "${statusLabel}"`);

    // Check if we have a mapping for this status
    const hireHopStatus = STATUS_MAPPING[columnId][statusLabel];
    if (hireHopStatus === undefined) {
      console.log(`⏭️ Status "${statusLabel}" not in our mapping for column ${columnId}, ignoring`);
      console.log(`Available mappings for ${columnId}:`, Object.keys(STATUS_MAPPING[columnId]));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Status not mapped',
          availableMappings: Object.keys(STATUS_MAPPING[columnId])
        })
      };
    }

    // Get the job ID from Monday.com item with retry
    const jobId = await getJobIdFromMondayItemWithRetry(itemId, boardId);
    if (!jobId) {
      console.error('❌ Could not find job ID for Monday.com item:', itemId);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID not found' })
      };
    }

    console.log(`🎯 Syncing job ${jobId}: Monday "${statusLabel}" -> HireHop status ${hireHopStatus} (${HIREHOP_STATUS_NAMES[hireHopStatus]})`);

    // 🔧 ENHANCED: Add random delay for batch processing to spread load
    const batchDelay = Math.random() * 2000; // 0-2 seconds random delay
    console.log(`⏱️ Adding ${Math.round(batchDelay)}ms batch processing delay`);
    await sleep(batchDelay);

    // Update HireHop status with retry logic
    const updateResult = await updateHireHopJobStatusWithRetry(jobId, hireHopStatus);

    if (updateResult.success) {
      console.log(`✅ Successfully updated HireHop job ${jobId} to status ${hireHopStatus} (attempts: ${updateResult.attempts})`);
      
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
          statusName: HIREHOP_STATUS_NAMES[hireHopStatus],
          attempts: updateResult.attempts,
          processingTime: updateResult.processingTime
        })
      };
    } else {
      console.error(`❌ Failed to update HireHop job ${jobId} after ${updateResult.attempts} attempts:`, updateResult.error);
      
      // Still return 200 to prevent Monday.com from retrying immediately
      // You might want to implement a dead letter queue or manual retry system here
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false,
          error: 'Failed to update HireHop status after retries',
          details: updateResult.error,
          attempts: updateResult.attempts
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

// 🆕 Enhanced status label extraction
function extractStatusLabel(value) {
  console.log('🔍 DEBUGGING STATUS EXTRACTION:');
  console.log('Raw value type:', typeof value);
  console.log('Raw value:', JSON.stringify(value, null, 2));
  
  if (typeof value === 'string') {
    console.log('✅ Extracted from direct string:', value);
    return value;
  } 
  
  if (value && typeof value === 'object') {
    // Try multiple extraction paths
    if (value.label && value.label.text) {
      console.log('✅ Extracted from value.label.text:', value.label.text);
      return value.label.text;
    } else if (value.label && typeof value.label === 'string') {
      console.log('✅ Extracted from value.label:', value.label);
      return value.label;
    } else if (value.text) {
      console.log('✅ Extracted from value.text:', value.text);
      return value.text;
    } else if (value.name) {
      console.log('✅ Extracted from value.name:', value.name);
      return value.name;
    } else {
      // Try to find any string value in the object
      const stringValues = Object.values(value).filter(v => typeof v === 'string');
      if (stringValues.length > 0) {
        console.log('✅ Extracted from first string value:', stringValues[0]);
        return stringValues[0];
      }
    }
  }

  // Try JSON parsing if it's a stringified object
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      console.log('🔍 Parsed string value:', parsed);
      if (parsed.label && parsed.label.text) {
        console.log('✅ Extracted from parsed.label.text:', parsed.label.text);
        return parsed.label.text;
      } else if (parsed.text) {
        console.log('✅ Extracted from parsed.text:', parsed.text);
        return parsed.text;
      }
    } catch (e) {
      console.log('⚠️ Value is not valid JSON string');
    }
  }
  
  console.log('❌ Could not extract status label');
  return null;
}

// 🆕 Get job ID with retry logic
async function getJobIdFromMondayItemWithRetry(itemId, boardId, attempt = 1) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    if (!mondayApiKey) {
      throw new Error('Monday.com API key not configured');
    }

    console.log(`🔍 Searching for job ID in Monday item ${itemId} (attempt ${attempt})`);

    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          column_values(ids: ["text7"]) {
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
        'Authorization': mondayApiKey,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      throw new Error(`Monday.com API HTTP error: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`Monday.com API errors: ${JSON.stringify(result.errors)}`);
    }

    const items = result.data?.items || [];
    if (items.length === 0) {
      console.log(`❌ No Monday item found with ID ${itemId}`);
      return null;
    }

    const item = items[0];
    console.log(`📋 Found Monday item: "${item.name}"`);
    
    const jobIdColumn = item.column_values?.[0];
    const extractedJobId = jobIdColumn?.text || jobIdColumn?.value || null;
    
    if (!extractedJobId) {
      console.log(`⚠️ No job ID found in text7 column for Monday item "${item.name}" (${itemId})`);
      return null;
    }

    console.log(`✅ Found job ID: ${extractedJobId} for Monday item "${item.name}"`);
    return extractedJobId;

  } catch (error) {
    console.error(`❌ Error getting job ID from Monday.com (attempt ${attempt}):`, error);
    
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1),
        RETRY_CONFIG.maxDelay
      );
      console.log(`⏱️ Retrying Monday.com query in ${delay}ms...`);
      await sleep(delay);
      return await getJobIdFromMondayItemWithRetry(itemId, boardId, attempt + 1);
    }
    
    return null;
  }
}

// 🆕 Update HireHop job status with retry logic
async function updateHireHopJobStatusWithRetry(jobId, newStatus, attempt = 1) {
  const startTime = Date.now();
  
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';

    if (!token) {
      throw new Error('HireHop API token not configured');
    }

    console.log(`🏢 Updating HireHop job ${jobId} to status ${newStatus} (attempt ${attempt})`);

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

      const processingTime = Date.now() - startTime;
      console.log(`✅ HireHop update successful in ${processingTime}ms`);

      return { 
        success: true, 
        status: newStatus, 
        response: result, 
        attempts: attempt,
        processingTime: processingTime
      };
    } else {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

  } catch (error) {
    console.error(`❌ Error updating HireHop job status (attempt ${attempt}):`, error);
    
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1),
        RETRY_CONFIG.maxDelay
      );
      console.log(`⏱️ Retrying HireHop update in ${delay}ms...`);
      await sleep(delay);
      return await updateHireHopJobStatusWithRetry(jobId, newStatus, attempt + 1);
    }
    
    const processingTime = Date.now() - startTime;
    return { 
      success: false, 
      error: error.message, 
      attempts: attempt,
      processingTime: processingTime
    };
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

// 🆕 Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
