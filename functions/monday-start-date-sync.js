// functions/monday-start-date-sync.js
// Syncs ONLY start date changes from Monday.com to HireHop outgoing date

const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('📅 Monday.com START date sync webhook received');
    
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Preflight call successful' }) };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (parseError) {
      console.error('❌ Failed to parse webhook payload:', parseError);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON payload' }) };
    }

    console.log('📅 Monday.com start date payload:', JSON.stringify(payload, null, 2));

    // Handle verification challenge
    if (payload.challenge) {
      return { statusCode: 200, headers, body: JSON.stringify({ challenge: payload.challenge }) };
    }

    if (!payload.event || payload.event.columnId !== 'date') {
      console.log('⚠️ Not a start date change, ignoring');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Not start date column' }) };
    }

    const { value } = payload.event;
    const itemId = payload.event.pulseId || payload.event.itemId;

    // Extract date value
    let dateValue = null;
    if (typeof value === 'string') {
      dateValue = value;
    } else if (value && value.date) {
      dateValue = value.date;
    }

    if (!dateValue) {
      console.log('⚠️ Could not extract start date value');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Could not extract date' }) };
    }

    console.log(`📅 Start date change: ${dateValue}`);

    // Get job ID
    const jobId = await getJobIdFromMondayItem(itemId);
    if (!jobId) {
      console.error('❌ Could not find job ID for Monday.com item:', itemId);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Job ID not found' }) };
    }

    // Update ONLY the outgoing date in HireHop
    const updateResult = await updateHireHopOutgoingDate(jobId, dateValue);

    if (updateResult.success) {
      console.log(`✅ Successfully updated HireHop job ${jobId} outgoing date to ${dateValue}`);
      
      await addHireHopNote(jobId, `📅 Outgoing date synced from Monday.com: ${dateValue}`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          jobId: jobId,
          outgoingDate: dateValue
        })
      };
    } else {
      console.error(`❌ Failed to update HireHop job ${jobId} outgoing date:`, updateResult.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to update HireHop outgoing date', details: updateResult.error })
      };
    }

  } catch (error) {
    console.error('❌ Monday.com start date sync error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};

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

// Update ONLY HireHop outgoing date
async function updateHireHopOutgoingDate(jobId, startDate) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';

    if (!token) {
      throw new Error('HireHop API token not configured');
    }

    console.log(`📅 Updating HireHop job ${jobId} outgoing date to: ${startDate}`);

    // Validate job access
    const validateUrl = `https://${hirehopDomain}/php_functions/job_refresh.php?job=${jobId}&token=${encodeURIComponent(token)}`;
    const validateResponse = await fetch(validateUrl);
    const validateText = await validateResponse.text();
    
    let jobDetails;
    try {
      jobDetails = JSON.parse(validateText);
    } catch (e) {
      throw new Error("Failed to access job with current token");
    }
    
    if (jobDetails.LOCKED === 1) {
      return {
        success: false,
        error: "Job is locked in HireHop and cannot be modified"
      };
    }

    // Update ONLY outgoing date
    const updateUrl = `https://${hirehopDomain}/php_functions/job_save.php?token=${encodeURIComponent(token)}`;
    const requestData = new URLSearchParams();
    requestData.append('job', jobId);
    requestData.append('out', `${startDate} 09:00:00`);
    
    console.log(`📅 Setting outgoing date: out=${startDate} 09:00:00`);
    
    const response = await fetch(updateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestData.toString()
    });
    
    const result = await response.text();
    console.log(`HireHop response: ${result.substring(0, 200)}...`);
    
    if (result.includes("error")) {
      let errorCode;
      try {
        const errorObj = JSON.parse(result);
        errorCode = errorObj.error;
      } catch (e) {
        errorCode = "unknown";
      }
      
      return {
        success: false,
        error: `HireHop error ${errorCode}`,
        response: result
      };
    } else {
      return {
        success: true,
        message: "HireHop outgoing date updated successfully"
      };
    }

  } catch (error) {
    console.error('Error updating HireHop outgoing date:', error);
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
