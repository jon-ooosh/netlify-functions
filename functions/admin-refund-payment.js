// Fixed admin-refund-payment.js - Use payment application API like manual refunds + Stripe payment ID extraction
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const { validateSessionToken } = require('./admin-auth');

exports.handler = async (event, context) => {
  try {
    console.log('💸 ADMIN REFUND: Starting refund process');
    
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Preflight call successful' }) };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    
    // Validate admin session
    const authHeader = event.headers.authorization;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin authentication not configured' }) };
    }
    
    const tokenValidation = validateSessionToken(authHeader, adminPassword);
    if (!tokenValidation.valid) {
      console.log(`❌ Invalid admin token: ${tokenValidation.error}`);
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }
    
    // Parse request body
    let requestData;
    try {
      requestData = JSON.parse(event.body);
    } catch (parseError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
    }
    
    const { jobId, amount, reason, notes, paymentId, depositId } = requestData;
    
    // Validate required fields
    if (!jobId || !amount || !reason) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: jobId, amount, reason' }) };
    }
    
    if (amount <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Refund amount must be greater than zero' }) };
    }
    
    console.log(`💸 Processing refund: Job ${jobId}, Amount: £${amount}, Reason: ${reason}`);
    
    // STEP 1: Process Stripe refund
    console.log('💳 STEP 1: Processing Stripe refund...');
    let stripeRefund = null;
    
    // 🔧 FIXED: Extract Stripe payment ID from deposit memo for excess deposits only
    let stripePaymentId = paymentId;
    
    if (!stripePaymentId && depositId) {
      console.log('🔍 Attempting to extract Stripe payment ID from HireHop deposit memo...');
      stripePaymentId = await extractStripePaymentIdFromDeposit(jobId, depositId);
    }
    
    if (stripePaymentId) {
      try {
        // Create refund in Stripe
        stripeRefund = await stripe.refunds.create({
          payment_intent: stripePaymentId,
          amount: Math.round(amount * 100), // Convert to pence
          metadata: {
            jobId: jobId.toString(),
            refundType: 'excess_refund',
            refundReason: reason,
            adminRefund: 'true',
            originalDepositId: depositId || 'unknown'
          },
          reason: 'requested_by_customer' // Standard Stripe reason
        });
        
        console.log(`✅ Stripe refund created: ${stripeRefund.id}, Status: ${stripeRefund.status}`);
        
      } catch (stripeError) {
        console.error('❌ Stripe refund error:', stripeError);
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Failed to process Stripe refund',
            details: stripeError.message
          })
        };
      }
    } else {
      console.log('⚠️ No Stripe payment ID found - processing HireHop refund only (manual/bank transfer refund)');
    }
    
    // STEP 2: Create HireHop payment application (refund) using the correct API
    console.log('🏢 STEP 2: Creating HireHop payment application (refund)...');
    const hirehopResult = await createHireHopPaymentApplication(jobId, amount, reason, notes, stripeRefund?.id, depositId);
    
    if (!hirehopResult.success) {
      console.error('❌ HireHop payment application creation failed:', hirehopResult.error);
      
      // TODO: In production, you might want to reverse the Stripe refund here
      // since the HireHop refund failed
      
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create HireHop refund',
          details: hirehopResult.error,
          stripeRefundId: stripeRefund?.id
        })
      };
    }
    
    // STEP 4: Update Monday.com status to correct status name
    console.log('📋 STEP 4: Updating Monday.com status...');
    const mondayResult = await updateMondayExcessStatus(jobId, 'Excess reimbursed / released in full or part');
    
    // STEP 5: Add HireHop note about the refund
    console.log('📝 STEP 5: Adding HireHop note...');
    const noteText = `💸 EXCESS REFUND PROCESSED: £${amount.toFixed(2)} refunded to customer
${stripeRefund ? `💳 Stripe Refund: ${stripeRefund.id}` : '🏦 Manual/Bank Transfer Refund'}
📋 Reason: ${reason}
${notes ? `💬 Notes: ${notes}` : ''}
✅ HireHop Payment Application: ${hirehopResult.applicationId} created successfully
${stripePaymentId ? `🔗 Original Stripe Payment: ${stripePaymentId}` : ''}
📋 Monday.com Status: ${mondayResult.success ? 'Updated to "Excess reimbursed / released in full or part"' : 'Update failed'}`;
    
    await addHireHopNote(jobId, noteText);
    
    console.log(`✅ REFUND COMPLETE: £${amount} refunded successfully`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Successfully refunded £${amount.toFixed(2)} to customer`,
        refundDetails: {
          jobId: jobId,
          amount: amount,
          reason: reason,
          stripeRefundId: stripeRefund?.id,
          stripePaymentId: stripePaymentId,
          hirehopApplicationId: hirehopResult.applicationId,
          refundMethod: stripeRefund ? 'stripe' : 'manual'
        }
      })
    };
    
  } catch (error) {
    console.error('❌ Admin refund error:', error);
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

// 🔧 FIXED: Create HireHop payment application (this is how refunds work in HireHop)
async function createHireHopPaymentApplication(jobId, amount, reason, notes, stripeRefundId, depositId) {
  try {
    console.log(`💸 Creating HireHop payment application: Job ${jobId}, Amount: £${amount}, DepositId: ${depositId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      throw new Error('HireHop API token not configured');
    }
    
    // Get client ID for this job
    const clientId = await getJobClientId(jobId, token, hirehopDomain);
    
    // Create description and memo for refund
    const description = `${jobId} - Excess refund: ${reason}`;
    const currentDate = new Date().toISOString().split('T')[0];
    
    let memo = '';
    if (stripeRefundId) {
      const stripeUrl = `https://dashboard.stripe.com/refunds/${stripeRefundId}`;
      memo = `Stripe Refund: ${stripeUrl}`;
    } else {
      memo = `Manual refund processed via admin portal`;
    }
    
    if (notes) {
      memo += ` | Notes: ${notes}`;
    }
    
    // 🔧 FIXED: Strip the "e" prefix from deposit ID (HireHop expects numeric)
    let cleanDepositId = depositId;
    if (typeof depositId === 'string' && depositId.startsWith('e')) {
      cleanDepositId = depositId.substring(1);
      console.log(`🔧 Stripped "e" prefix: ${depositId} → ${cleanDepositId}`);
    }
    
    // 🎯 CORRECT ENDPOINT: billing_payments_save.php (from network capture)
    // 🔧 CRITICAL FIX: Ensure amount is passed correctly as a number
    const paymentApplicationData = {
      id: 0, // Always 0 for new payment applications
      date: currentDate,
      desc: description,
      amount: parseFloat(amount), // 🔧 FIXED: Ensure it's a proper number, not string
      paid: 1, // Mark as paid (from network capture)
      memo: memo,
      bank: 267, // Same bank account as original deposit (from capture)
      OWNER: 0, // From network capture
      deposit: cleanDepositId, // 🔧 FIXED: Use numeric ID without "e" prefix
      token: token
    };
    
    console.log('💸 STEP 1: Creating payment application using correct endpoint (billing_payments_save.php)');
    console.log('💸 Payment data:', JSON.stringify(paymentApplicationData, null, 2));
    
    // 🎯 Use the CORRECT endpoint discovered from network capture
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_payments_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(paymentApplicationData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = responseText;
    }
    
    console.log(`💸 Payment application response:`, parsedResponse);
    
    if (response.ok && (parsedResponse.hh_id || parsedResponse.success)) {
      const applicationId = parsedResponse.hh_id || 'created';
      console.log(`✅ STEP 1 SUCCESS: Payment application ${applicationId} created`);
      
      // 🎯 CRITICAL: Call tasks.php for Xero sync if needed
      if (parsedResponse.hh_id) {
        console.log('🔄 STEP 2: Triggering accounting tasks endpoint for Xero sync');
        
        const tasksResult = await triggerAccountingTasks(
          parsedResponse.hh_id,
          3, // ACC_PACKAGE_ID
          1, // PACKAGE_TYPE  
          token,
          hirehopDomain
        );
        
        console.log('📋 Tasks endpoint result:', tasksResult);
      }
      
      return {
        success: true,
        applicationId: applicationId
      };
    } else {
      console.log(`❌ Payment application creation failed:`, parsedResponse);
      return {
        success: false,
        error: `HireHop payment application creation failed: ${JSON.stringify(parsedResponse)}`
      };
    }
    
  } catch (error) {
    console.error('❌ Error creating HireHop payment application:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 🎯 THE CRITICAL DISCOVERED SOLUTION: Trigger accounting tasks (from proven pattern)
async function triggerAccountingTasks(applicationId, accPackageId, packageType, token, hirehopDomain) {
  try {
    const tasksData = {
      hh_package_type: packageType,
      hh_acc_package_id: accPackageId,
      hh_task: 'post_payment', // Different task for payment applications
      hh_id: applicationId,
      hh_acc_id: '',
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/accounting/tasks.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tasksData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    const success = response.ok && !responseText.includes('login') && !responseText.toLowerCase().includes('error');
    
    return { success: success, response: parsedResponse, httpStatus: response.status };
    
  } catch (error) {
    console.error('❌ Error calling tasks.php:', error);
    return { success: false, error: error.message };
  }
}

// 🔧 NEW: Extract Stripe payment ID from HireHop deposit memo (for excess deposits only)
async function extractStripePaymentIdFromDeposit(jobId, depositId) {
  try {
    console.log(`🔍 Extracting Stripe payment ID from deposit ${depositId} for job ${jobId}`);
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      console.log('❌ HireHop API token not configured');
      return null;
    }
    
    // Clean deposit ID (remove "e" prefix if present)
    let cleanDepositId = depositId;
    if (typeof depositId === 'string' && depositId.startsWith('e')) {
      cleanDepositId = depositId.substring(1);
    }
    
    // Get billing data for this job to find the specific deposit
    const encodedToken = encodeURIComponent(token);
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    const billingResponse = await fetch(billingUrl);
    
    if (!billingResponse.ok) {
      console.log('❌ Failed to fetch billing data from HireHop');
      return null;
    }
    
    const billingData = await billingResponse.json();
    
    if (billingData.error) {
      console.log('❌ HireHop billing API error:', billingData.error);
      return null;
    }
    
    // Find the specific deposit and check if it's an excess deposit
    for (const row of billingData.rows || []) {
      if (row.kind === 6 && // Deposit/Payment
          (row.id === depositId || row.id === cleanDepositId || row.id === `e${cleanDepositId}`)) {
        
        console.log(`📋 Found deposit: ID=${row.id}, Description="${row.desc}"`);
        
        // 🔧 CRITICAL: Only extract payment IDs from excess deposits
        const description = (row.desc || '').toLowerCase();
        const isExcessDeposit = description.includes('excess') || 
                               description.includes('xs') || 
                               description.includes('insurance');
        
        if (!isExcessDeposit) {
          console.log('⚠️ Deposit is not an excess deposit - skipping Stripe payment ID extraction');
          return null;
        }
        
        console.log('✅ Confirmed excess deposit - extracting Stripe payment ID');
        
        // Extract Stripe payment ID from memo field
        const memo = row.data?.MEMO || '';
        console.log(`🔍 Searching memo for Stripe payment ID: "${memo}"`);
        
        // Look for Stripe payment intent pattern: pi_[alphanumeric_underscore]+
        const stripePaymentMatch = memo.match(/pi_[a-zA-Z0-9_]+/);
        
        if (stripePaymentMatch) {
          const paymentId = stripePaymentMatch[0];
          console.log(`✅ Extracted Stripe payment ID: ${paymentId}`);
          return paymentId;
        } else {
          console.log('⚠️ No Stripe payment ID pattern found in memo');
          return null;
        }
      }
    }
    
    console.log(`❌ Deposit ${depositId} not found in billing data`);
    return null;
    
  } catch (error) {
    console.error('❌ Error extracting Stripe payment ID from deposit:', error);
    return null;
  }
}

// Update Monday.com excess status
async function updateMondayExcessStatus(jobId, newStatus) {
  try {
    console.log(`📋 Updating Monday.com excess status for job ${jobId} to "${newStatus}"`);
    
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    if (!mondayApiKey || !mondayBoardId) {
      console.log('⚠️ Monday.com credentials not configured, skipping status update');
      return { success: false, error: 'No credentials' };
    }
    
    // Find Monday.com item
    const mondayItem = await findMondayItem(jobId, mondayApiKey, mondayBoardId);
    
    if (!mondayItem) {
      console.log('⚠️ Job not found in Monday.com for status update');
      return { success: false, error: 'Job not found' };
    }
    
    console.log(`✅ Found Monday.com item for status update: ${mondayItem.id}`);
    
    // Update the excess status column (status58)
    const updateResult = await updateMondayColumn(
      mondayItem.id,
      'status58', // Insurance excess column
      newStatus,
      mondayApiKey,
      mondayBoardId
    );
    
    if (updateResult.success) {
      console.log(`✅ Updated Monday.com excess status to "${newStatus}"`);
    } else {
      console.error('❌ Failed to update Monday.com excess status:', updateResult.error);
    }
    
    return updateResult;
    
  } catch (error) {
    console.error('❌ Error updating Monday.com excess status:', error);
    return { success: false, error: error.message };
  }
}

// Helper function to find Monday.com item
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

// Helper function to update Monday.com column
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

// Get job client ID (from proven pattern)
async function getJobClientId(jobId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const jobDataUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
    
    const response = await fetch(jobDataUrl);
    const jobData = await response.json();
    
    if (jobData && jobData.CLIENT_ID) {
      return jobData.CLIENT_ID;
    } else {
      console.log('⚠️ Could not get client ID, using fallback');
      return 1822; // Fallback client ID
    }
  } catch (error) {
    console.error('Error getting client ID:', error);
    return 1822; // Fallback client ID
  }
}

// Add HireHop note (from proven pattern)
async function addHireHopNote(jobId, noteText) {
  try {
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    const encodedToken = encodeURIComponent(token);
    
    const noteUrl = `https://${hirehopDomain}/api/job_note.php?job=${jobId}&note=${encodeURIComponent(noteText)}&token=${encodedToken}`;
    const response = await fetch(noteUrl);
    
    console.log(`📝 HireHop note added: ${response.ok ? 'Success' : 'Failed'}`);
    return response.ok;
  } catch (error) {
    console.error('❌ Error adding HireHop note:', error);
    return false;
  }
}
