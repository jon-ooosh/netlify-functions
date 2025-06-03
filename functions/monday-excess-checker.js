// monday-excess-checker.js - Check Monday.com for excess payment status
const fetch = require('node-fetch');

// Check Monday.com for excess payment status
async function checkMondayExcessStatus(jobId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping excess status check');
      return { found: false, reason: 'no_credentials' };
    }
    
    console.log(`🔍 Checking Monday.com excess status for job ${jobId}`);
    
    // Find the Monday.com item
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
    
    // Extract the insurance excess status
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
    
    console.log(`📋 Monday.com excess status: "${excessStatus}", Has Stripe link: ${hasStripeLink}`);
    
    // Determine excess payment status
    let excessPaid = 0;
    let excessMethod = 'not_required';
    let excessDescription = 'No excess required';
    
    if (excessStatus === 'Excess paid') {
      excessPaid = 1200; // Assume £1200 standard excess
      excessMethod = 'completed';
      excessDescription = 'Excess payment completed via Monday.com record';
    } else if (excessStatus === 'Pre-auth taken' || hasStripeLink) {
      excessPaid = 0; // Pre-auth doesn't count as "paid"
      excessMethod = 'pre-auth_completed';
      excessDescription = 'Pre-authorization completed via Monday.com record';
    }
    
    return {
      found: true,
      mondayItemId: item.id,
      excessStatus: excessStatus,
      hasStripeLink: hasStripeLink,
      mondayExcessData: {
        paid: excessPaid,
        method: excessMethod,
        description: excessDescription,
        source: 'monday.com'
      }
    };
    
  } catch (error) {
    console.error('Error checking Monday.com excess status:', error);
    return { found: false, reason: 'error', error: error.message };
  }
}

module.exports = {
  checkMondayExcessStatus
};
