// monday-excess-checker.js - UPDATED: Support for both payment intents and setup intents

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
    
    const query = `
      query {
        items_page_by_column_values(
          board_id: ${mondayBoardId}
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
    console.log(`📋 Monday.com API response:`, JSON.stringify(result, null, 2));
    
    if (result.errors) {
      console.error('❌ Monday.com API errors:', result.errors);
      return { found: false, reason: 'api_error', error: result.errors };
    }
    
    const items = result.data?.items_page_by_column_values?.items || [];
    console.log(`📋 Found ${items.length} items for job ${jobId}`);
    
    if (items.length === 0) {
      console.log(`📋 No Monday.com item found for job ${jobId}`);
      return { found: false, reason: 'job_not_found' };
    }
    
    const item = items[0];
    console.log(`📋 Found Monday.com item: ${item.id}`);
    
    const updates = item.updates || [];
    console.log(`📋 Item has ${updates.length} updates to search`);
    
    let preAuthUpdate = null;
    let intentId = null;
    let intentType = null;
    let preAuthAmount = null;
    
    // 🔧 UPDATED: Search for both payment intents and setup intents
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      console.log(`📝 Checking update ${i + 1}/${updates.length}: ${update.id}`);
      console.log(`📝 Update body preview: ${update.body ? update.body.substring(0, 100) + '...' : 'No body'}`);
      
      if (update.body && update.body.includes('🔐 PRE-AUTH COMPLETED:')) {
        console.log(`✅ FOUND PRE-AUTH COMPLETION in update ${update.id}!`);
        preAuthUpdate = update;
        
        // 🔧 UPDATED: Look for BOTH Payment Intent ID and Setup Intent ID patterns
        
        // Pattern 1: Payment Intent ID (new manual capture method)
        let paymentIntentMatch = update.body.match(/Payment Intent ID: (pi_[a-zA-Z0-9_]+)/);
        if (paymentIntentMatch) {
          intentId = paymentIntentMatch[1];
          intentType = 'payment_intent';
          console.log(`🔗 Extracted Payment Intent ID: ${intentId}`);
        } else {
          // Check for payment intent in Stripe link
          paymentIntentMatch = update.body.match(/https:\/\/dashboard\.stripe\.com\/payments\/(pi_[a-zA-Z0-9_]+)/);
          if (paymentIntentMatch) {
            intentId = paymentIntentMatch[1];
            intentType = 'payment_intent';
            console.log(`🔗 Extracted Payment Intent ID from Stripe link: ${intentId}`);
          }
        }
        
        // Pattern 2: Setup Intent ID (legacy method) - only check if we didn't find a payment intent
        if (!intentId) {
          let setupIntentMatch = update.body.match(/Setup Intent ID: (seti_[a-zA-Z0-9_]+)/);
          if (setupIntentMatch) {
            intentId = setupIntentMatch[1];
            intentType = 'setup_intent';
            console.log(`🔗 Extracted Setup Intent ID: ${intentId}`);
          } else {
            // Check for setup intent in Stripe link
            setupIntentMatch = update.body.match(/https:\/\/dashboard\.stripe\.com\/setup_intents\/(seti_[a-zA-Z0-9_]+)/);
            if (setupIntentMatch) {
              intentId = setupIntentMatch[1];
              intentType = 'setup_intent';
              console.log(`🔗 Extracted Setup Intent ID from Stripe link: ${intentId}`);
            }
          }
        }
        
        // Pattern 3: Generic pattern as fallback
        if (!intentId) {
          const genericMatch = update.body.match(/(pi_[a-zA-Z0-9_]+|seti_[a-zA-Z0-9_]+)/);
          if (genericMatch) {
            intentId = genericMatch[1];
            intentType = intentId.startsWith('pi_') ? 'payment_intent' : 'setup_intent';
            console.log(`🔗 Extracted ${intentType} ID from general pattern: ${intentId}`);
          }
        }
        
        // Extract amount from the update
        const amountMatch = update.body.match(/£([0-9]+\.?[0-9]*)/);
        if (amountMatch) {
          preAuthAmount = parseFloat(amountMatch[1]);
          console.log(`💰 Extracted amount: £${preAuthAmount}`);
        }
        
        break; // Take the first (most recent) match
      }
    }
    
    if (preAuthUpdate) {
      console.log(`✅ PRE-AUTH DETECTION SUCCESS: Found completed pre-auth in update ${preAuthUpdate.id}`);
      console.log(`   Intent Type: ${intentType}`);
      console.log(`   Intent ID: ${intentId}`);
      
      return {
        found: true,
        preAuthCompleted: true,
        intentId: intentId,
        intentType: intentType,
        isManualCapture: intentType === 'payment_intent',
        amount: preAuthAmount || 1200,
        updateId: preAuthUpdate.id,
        createdAt: preAuthUpdate.created_at,
        creator: preAuthUpdate.creator?.name,
        mondayItemId: item.id,
        updateBody: preAuthUpdate.body
      };
    } else {
      console.log(`📋 PRE-AUTH DETECTION: No pre-auth completion found in ${updates.length} updates for job ${jobId}`);
      return {
        found: true,
        preAuthCompleted: false,
        mondayItemId: item.id,
        totalUpdates: updates.length
      };
    }
    
  } catch (error) {
    console.error('❌ Error checking Monday.com pre-auth status:', error);
    return { found: false, reason: 'error', error: error.message };
  }
}

// 🔧 UPDATED: Main function with enhanced intent type detection
async function checkMondayExcessStatus(jobId) {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping excess status check');
      return { found: false, reason: 'no_credentials' };
    }
    
    console.log(`🔍 MAIN EXCESS CHECK: Starting Monday.com excess status check for job ${jobId}`);
    
    const query = `
      query {
        items_page_by_column_values(
          board_id: ${mondayBoardId}
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
      }
    `;
    
    console.log(`📤 Sending Monday.com query for job ${jobId}`);
    
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
      console.error(`❌ Monday.com API HTTP error: ${response.status} ${response.statusText}`);
      return { found: false, reason: 'http_error', status: response.status };
    }
    
    const result = await response.json();
    console.log(`📥 Monday.com API response received`);
    
    if (result.errors) {
      console.error('❌ Monday.com API errors:', result.errors);
      return { found: false, reason: 'api_error', error: result.errors };
    }
    
    const items = result.data?.items_page_by_column_values?.items || [];
    console.log(`📋 Query returned ${items.length} items`);
    
    if (items.length === 0) {
      console.log(`📋 No Monday.com item found for job ${jobId}`);
      return { found: false, reason: 'job_not_found' };
    }
    
    const item = items[0];
    console.log(`📋 Found Monday.com item: ${item.id} - "${item.name}"`);
    
    // Extract the insurance excess status from columns
    const excessColumn = item.column_values.find(col => col.id === 'status58');
    const stripeXsColumn = item.column_values.find(col => col.id === 'text_mkrjj4sa');
    
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
        console.log(`📋 Excess column status: "${excessStatus}"`);
      } catch (e) {
        excessStatus = excessColumn.value;
        console.log(`📋 Excess column raw value: "${excessStatus}"`);
      }
    }
    
    if (stripeXsColumn && stripeXsColumn.text) {
      hasStripeLink = stripeXsColumn.text.includes('stripe.com');
      console.log(`🔗 Has Stripe link: ${hasStripeLink}`);
    }
    
    // 🔧 UPDATED: Enhanced pre-auth detection with intent type support
    const updates = item.updates || [];
    console.log(`📝 Searching ${updates.length} updates for pre-auth completion...`);
    
    let preAuthUpdate = null;
    let intentId = null;
    let intentType = null;
    let preAuthAmount = null;
    
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      
      if (update.body && update.body.includes('🔐 PRE-AUTH COMPLETED:')) {
        console.log(`✅ FOUND PRE-AUTH COMPLETION in update ${i + 1}/${updates.length}!`);
        console.log(`📝 Update content: ${update.body.substring(0, 200)}...`);
        preAuthUpdate = update;
        
        // 🔧 UPDATED: Look for both payment and setup intents
        
        // Check for Payment Intent first (newer method)
        let paymentIntentMatch = update.body.match(/Payment Intent ID: (pi_[a-zA-Z0-9_]+)/);
        if (paymentIntentMatch) {
          intentId = paymentIntentMatch[1];
          intentType = 'payment_intent';
          console.log(`🔗 Found Payment Intent ID: ${intentId}`);
        } else {
          paymentIntentMatch = update.body.match(/https:\/\/dashboard\.stripe\.com\/payments\/(pi_[a-zA-Z0-9_]+)/);
          if (paymentIntentMatch) {
            intentId = paymentIntentMatch[1];
            intentType = 'payment_intent';
            console.log(`🔗 Found Payment Intent ID from link: ${intentId}`);
          }
        }
        
        // If no payment intent, check for Setup Intent (legacy method)
        if (!intentId) {
          let setupIntentMatch = update.body.match(/Setup Intent ID: (seti_[a-zA-Z0-9_]+)/);
          if (setupIntentMatch) {
            intentId = setupIntentMatch[1];
            intentType = 'setup_intent';
            console.log(`🔗 Found Setup Intent ID: ${intentId}`);
          } else {
            setupIntentMatch = update.body.match(/https:\/\/dashboard\.stripe\.com\/setup_intents\/(seti_[a-zA-Z0-9_]+)/);
            if (setupIntentMatch) {
              intentId = setupIntentMatch[1];
              intentType = 'setup_intent';
              console.log(`🔗 Found Setup Intent ID from link: ${intentId}`);
            }
          }
        }
        
        // Generic fallback pattern
        if (!intentId) {
          const genericMatch = update.body.match(/(pi_[a-zA-Z0-9_]+|seti_[a-zA-Z0-9_]+)/);
          if (genericMatch) {
            intentId = genericMatch[1];
            intentType = intentId.startsWith('pi_') ? 'payment_intent' : 'setup_intent';
            console.log(`🔗 Found ${intentType} from generic pattern: ${intentId}`);
          }
        }
        
        // Extract amount
        const amountMatch = update.body.match(/£([0-9]+\.?[0-9]*)/);
        if (amountMatch) {
          preAuthAmount = parseFloat(amountMatch[1]);
          console.log(`💰 Found amount: £${preAuthAmount}`);
        }
        
        break;
      } else if (i < 5) {
        console.log(`📝 Update ${i + 1}: ${update.body ? `"${update.body.substring(0, 50)}..."` : 'No body'}`);
      }
    }
    
    console.log(`📋 Monday.com status summary: Excess="${excessStatus}", Stripe Link=${hasStripeLink}, Pre-auth Update=${!!preAuthUpdate}`);
    
    // Determine excess payment status
    let excessPaid = 0;
    let excessMethod = 'not_required';
    let excessDescription = 'No excess required';
    
    if (preAuthUpdate) {
      console.log(`🔐 DETECTED: Pre-auth completed via Monday.com update`);
      console.log(`   Type: ${intentType === 'payment_intent' ? 'TRUE PRE-AUTH (manual capture)' : 'LEGACY (setup intent)'}`);
      excessPaid = 0;
      excessMethod = 'pre-auth_completed';
      excessDescription = intentType === 'payment_intent' 
        ? 'Pre-authorization completed (manual capture - no auth required)'
        : 'Pre-authorization completed (legacy - may require auth)';
    } else if (excessStatus === 'Pre-auth taken' || hasStripeLink) {
      console.log(`🔐 DETECTED: Pre-auth completed via Monday.com column`);
      excessPaid = 0;
      excessMethod = 'pre-auth_completed';
      excessDescription = 'Pre-authorization completed via Monday.com column';
    } else if (excessStatus === 'Pre-auth claimed') {
      console.log(`💰 DETECTED: Pre-auth has been claimed`);
      excessPaid = 1200;
      excessMethod = 'claimed';
      excessDescription = 'Pre-authorization has been claimed';
    } else if (excessStatus === 'Excess paid') {
      console.log(`💰 DETECTED: Excess payment completed`);
      excessPaid = 1200;
      excessMethod = 'completed';
      excessDescription = 'Excess payment completed via Monday.com record';
    } else if (excessStatus === 'Retained from previous hire') {
      console.log(`🔄 DETECTED: Excess retained from previous hire`);
      excessPaid = 1200;
      excessMethod = 'retained';
      excessDescription = 'Excess retained from previous hire';
    } else {
      console.log(`📋 NO EXCESS: No excess payment or pre-auth detected`);
    }
    
    const excessResult = {
      found: true,
      mondayItemId: item.id,
      excessStatus: excessStatus,
      hasStripeLink: hasStripeLink,
      preAuthUpdate: preAuthUpdate ? {
        id: preAuthUpdate.id,
        intentId: intentId,
        intentType: intentType,
        isManualCapture: intentType === 'payment_intent',
        setupIntentId: intentType === 'setup_intent' ? intentId : null, // For backwards compatibility
        amount: preAuthAmount,
        createdAt: preAuthUpdate.created_at,
        creator: preAuthUpdate.creator?.name,
        body: preAuthUpdate.body
      } : null,
      mondayExcessData: {
        paid: excessPaid,
        method: excessMethod,
        description: excessDescription,
        source: preAuthUpdate ? 'monday_update' : 'monday_column',
        intentType: intentType
      }
    };
    
    console.log(`✅ EXCESS CHECK COMPLETE:`, JSON.stringify(excessResult, null, 2));
    
    return excessResult;
    
  } catch (error) {
    console.error('❌ Error in checkMondayExcessStatus:', error);
    return { found: false, reason: 'error', error: error.message };
  }
}

module.exports = {
  checkMondayExcessStatus,
  checkMondayPreAuthStatus
};
