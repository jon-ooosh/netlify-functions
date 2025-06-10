// functions/monday-date-sync.js
// Receives date updates from Monday.com and syncs to HireHop
// Handles the 2-date → 4-date mapping complexity

const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('📅 Monday.com date sync webhook received');
    
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

    console.log('📅 Monday.com date sync payload:', JSON.stringify(payload, null, 2));

    // Handle Monday.com webhook verification challenge
    if (payload.challenge) {
      console.log('📋 Monday.com webhook verification challenge received:', payload.challenge);
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
    
    // Check if this is a date column we care about
    const DATE_COLUMNS = {
      'date': 'hire_start',                    // Hire start in Monday
      'dup__of_hire_starts': 'hire_end'       // Hire end in Monday
    };

    if (!DATE_COLUMNS[columnId]) {
      console.log(`⏭️ Column ${columnId} is not a monitored date column, ignoring`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Date column not monitored' })
      };
    }

    // Extract date value from Monday.com payload
    let dateValue = null;
    
    if (typeof value === 'string') {
      dateValue = value;
    } else if (value && value.date) {
      dateValue = value.date;
    } else if (value && value.text) {
      dateValue = value.text;
    }

    if (!dateValue) {
      console.log('⚠️ Could not extract date value from payload');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Could not extract date value' })
      };
    }

    console.log(`📅 Date change detected: Column ${columnId} (${DATE_COLUMNS[columnId]}) -> ${dateValue}`);

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

    // Get both dates from Monday.com to ensure consistency
    const currentDates = await getBothDatesFromMondayItem(itemId, boardId);
    if (!currentDates) {
      console.error('❌ Could not retrieve current dates from Monday.com item');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to retrieve current dates' })
      };
    }

    console.log(`📅 Current Monday dates: Start=${currentDates.startDate}, End=${currentDates.endDate}`);

    // Update HireHop with both dates (ensures consistency)
    const updateResult = await updateHireHopDates(jobId, currentDates.startDate, currentDates.endDate);

    if (updateResult.success) {
      console.log(`✅ Successfully updated HireHop job ${jobId} dates`);
      
      // Add a note to HireHop about the date sync
      await addHireHopNote(jobId, 
        `📅 Dates synced from Monday.com: Start=${currentDates.startDate}, End=${currentDates.endDate}`
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          jobId: jobId,
          updatedDates: currentDates,
          hirehopResponse: updateResult.response
        })
      };
    } else {
      console.error(`❌ Failed to update HireHop job ${jobId} dates:`, updateResult.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'Failed to update HireHop dates',
          details: updateResult.error
        })
      };
    }

  } catch (error) {
    console.error('❌ Monday.com date sync error:', error);
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

// Get job ID from Monday.com item (reuse existing function)
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

// Get both start and end dates from Monday.com item
async function getBothDatesFromMondayItem(itemId, boardId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    if (!mondayApiKey) {
      throw new Error('Monday.com API key not configured');
    }

    // 🔧 UPDATED: Use your actual Monday column IDs
    const query = `
      query {
        items(ids: [${itemId}]) {
          column_values(ids: ["date", "dup__of_hire_starts"]) {
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

    const result = await response.json();

    if (result.errors) {
      console.error('Monday.com API errors:', result.errors);
      return null;
    }

    const items = result.data?.items || [];
    if (items.length === 0) {
      return null;
    }

    const columns = items[0].column_values || [];
    let startDate = null;
    let endDate = null;

    columns.forEach(column => {
      let dateValue = column.text || column.value;
      
      // Parse JSON value if needed
      if (column.value && !column.text) {
        try {
          const parsed = JSON.parse(column.value);
          dateValue = parsed.date || dateValue;
        } catch (e) {
          // Keep original value
        }
      }

      if (column.id === 'date') {
        startDate = dateValue;
      } else if (column.id === 'dup__of_hire_starts') {
        endDate = dateValue;
      }
    });

    return { startDate, endDate };

  } catch (error) {
    console.error('Error getting dates from Monday.com:', error);
    return null;
  }
}

// Update HireHop dates (enhanced from your Zapier code)
async function updateHireHopDates(jobId, startDate, endDate) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';

    if (!token) {
      throw new Error('HireHop API token not configured');
    }

    console.log(`📅 Updating HireHop job ${jobId} with dates: Start=${startDate}, End=${endDate}`);

    // First, validate we can access the job and check if it's locked
    console.log("Validating job access and checking lock status...");
    const validateUrl = `https://${hirehopDomain}/php_functions/job_refresh.php?job=${jobId}&token=${encodeURIComponent(token)}`;
    const validateResponse = await fetch(validateUrl);
    const validateText = await validateResponse.text();
    
    console.log(`Validation response status: ${validateResponse.status}`);
    
    // Parse the job details to check lock status
    let jobDetails;
    try {
      jobDetails = JSON.parse(validateText);
    } catch (e) {
      console.log(`Could not parse job details: ${e.message}`);
      throw new Error("Failed to access job with current token. Authentication issue detected.");
    }
    
    // Check if job is locked
    if (jobDetails.LOCKED === 1) {
      console.log(`Job ${jobId} is locked and cannot be modified.`);
      return {
        success: false,
        error: "Job is locked in HireHop and cannot be modified",
        recommendation: "Unlock the job in HireHop before attempting to update dates"
      };
    }

    // Now update the job dates using all 4 HireHop date fields
    const updateUrl = `https://${hirehopDomain}/php_functions/job_save.php?token=${encodeURIComponent(token)}`;
    
    console.log(`Using update URL: ${updateUrl}`);
    
    // 🎯 FOCUSED: Only update outgoing/returning dates (logistics), leave start/end dates (charging) alone
    const requestData = new URLSearchParams();
    requestData.append('job', jobId);
    
    if (startDate) {
      const startDateTime = `${startDate} 09:00:00`;
      requestData.append('out', startDateTime);    // Outgoing (collection) date only
      console.log(`Setting outgoing date: out=${startDateTime}`);
    }
    
    if (endDate) {
      const endDateTime = `${endDate} 09:00:00`;
      requestData.append('to', endDateTime);       // Returning date only
      console.log(`Setting returning date: to=${endDateTime}`);
    }
    
    console.log('📋 NOTE: Leaving HireHop start/end (charging) dates unchanged for independent management');
    
    const response = await fetch(updateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: requestData.toString()
    });
    
    const result = await response.text();
    console.log(`HireHop response: ${result}`);
    
    // Handle specific error codes
    if (result.includes("error")) {
      let errorCode;
      try {
        const errorObj = JSON.parse(result);
        errorCode = errorObj.error;
      } catch (e) {
        errorCode = "unknown";
      }
      
      let errorMessage = "Could not update HireHop dates";
      let recommendation = "Please contact HireHop support for guidance on updating job dates via API";
      
      // Known error codes
      if (errorCode === 320) {
        errorMessage = "Job is locked in HireHop";
        recommendation = "Unlock the job in HireHop before attempting to update dates";
      } else if (errorCode === 3) {
        errorMessage = "Missing required parameters";
        recommendation = "Ensure all required job fields are included in the update";
      }
      
      return {
        success: false,
        error: errorMessage,
        errorCode,
        response: result,
        recommendation
      };
    } else {
      console.log("✅ Success: Job dates updated in HireHop");
      
      return {
        success: true,
        message: "HireHop dates updated successfully",
        responseStatus: response.status,
        response: result
      };
    }

  } catch (error) {
    console.error('Error updating HireHop dates:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Add note to HireHop job (reuse existing function)
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
