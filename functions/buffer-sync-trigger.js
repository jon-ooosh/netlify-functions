// buffer-sync-trigger.js - Find and trigger manual sync for buffered deposits
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🔍 BUFFER SYNC TRIGGER - Finding and syncing buffered deposits');
    
    const params = new URLSearchParams(event.queryStringParameters);
    const action = params.get('action') || 'check'; // 'check' or 'sync'
    const jobId = params.get('jobId') || '13997';
    const depositId = params.get('depositId'); // Optional specific deposit
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    console.log(`Action: ${action}, JobId: ${jobId}, DepositId: ${depositId || 'all'}`);
    
    // STEP 1: Find "Invoices to be Exported" report
    console.log('📋 STEP 1: Accessing "Invoices to be Exported" report...');
    const bufferReport = await accessInvoicesToBeExported(token, hirehopDomain);
    
    // STEP 2: Look for our deposits in the buffer
    console.log('🔍 STEP 2: Searching for buffered deposits...');
    const bufferedDeposits = await findBufferedDeposits(jobId, depositId, token, hirehopDomain);
    
    // STEP 3: If action is 'sync', trigger the export
    let syncResults = null;
    if (action === 'sync') {
      console.log('🚀 STEP 3: Triggering buffer sync...');
      syncResults = await triggerBufferSync(bufferedDeposits, token, hirehopDomain);
    }
    
    // STEP 4: Verify results
    console.log('✅ STEP 4: Verifying results...');
    const verification = await verifyDepositSync(jobId, depositId, token, hirehopDomain);
    
    const report = {
      timestamp: new Date().toISOString(),
      action,
      jobId,
      depositId,
      results: {
        bufferReport,
        bufferedDeposits,
        syncResults,
        verification
      },
      instructions: {
        manualSteps: [
          "1. In HireHop, go to Home → Reports",
          "2. Look for 'Invoices to be Exported' report",
          "3. Check if your deposits (6365, 6368, 6371, 6372) are listed",
          "4. If found, there should be an 'Export' or 'Sync' button to trigger manual sync"
        ],
        apiAlternative: [
          "Use this function with action=sync to trigger automated buffer sync",
          "Example: /.netlify/functions/buffer-sync-trigger?action=sync&jobId=13997"
        ]
      }
    };
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2)
    };
    
  } catch (error) {
    console.error('❌ Buffer sync error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Buffer sync failed', 
        details: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// Access the "Invoices to be Exported" report
async function accessInvoicesToBeExported(token, hirehopDomain) {
  const reportEndpoints = [
    // Main reports endpoint
    `https://${hirehopDomain}/frames/reports.php`,
    // Specific export report
    `https://${hirehopDomain}/frames/invoices_to_be_exported.php`,
    // Alternative export endpoints
    `https://${hirehopDomain}/php_functions/export_buffer.php`,
    `https://${hirehopDomain}/frames/accounting_export.php`,
    // Reports list
    `https://${hirehopDomain}/php_functions/reports_list.php`
  ];
  
  const results = [];
  
  for (const endpoint of reportEndpoints) {
    try {
      console.log(`🔍 Trying report endpoint: ${endpoint.split('/').pop()}`);
      
      const response = await fetch(endpoint + `?token=${encodeURIComponent(token)}`, {
        method: 'GET'
      });
      
      const responseText = await response.text();
      
      results.push({
        endpoint: endpoint.split('/').pop(),
        status: response.status,
        success: response.ok,
        size: responseText.length,
        containsExport: responseText.toLowerCase().includes('export'),
        containsBuffer: responseText.toLowerCase().includes('buffer'),
        containsInvoice: responseText.toLowerCase().includes('invoice'),
        containsDeposit: responseText.toLowerCase().includes('deposit'),
        sample: responseText.substring(0, 200)
      });
      
      // If this looks like the right endpoint, save full response
      if (response.ok && (responseText.includes('export') || responseText.includes('buffer'))) {
        results[results.length - 1].fullResponse = responseText;
      }
      
    } catch (error) {
      results.push({
        endpoint: endpoint.split('/').pop(),
        error: error.message
      });
    }
  }
  
  return results;
}

// Find buffered deposits specific to our job
async function findBufferedDeposits(jobId, specificDepositId, token, hirehopDomain) {
  try {
    console.log(`🔍 Searching for buffered deposits for job ${jobId}${specificDepositId ? `, deposit ${specificDepositId}` : ''}`);
    
    // Try multiple approaches to find buffered items
    const searchMethods = [
      // Method 1: Direct buffer query
      {
        name: 'buffer_query',
        url: `https://${hirehopDomain}/php_functions/get_buffer_items.php`,
        data: { 
          job_id: jobId,
          type: 'deposits',
          accounting_package: 3,
          token 
        }
      },
      // Method 2: Export pending items
      {
        name: 'export_pending',
        url: `https://${hirehopDomain}/php_functions/get_export_pending.php`,
        data: { 
          package_id: 3,
          item_type: 'deposit',
          token 
        }
      },
      // Method 3: Accounting queue
      {
        name: 'accounting_queue',
        url: `https://${hirehopDomain}/php_functions/accounting_queue.php`,
        data: { 
          action: 'list',
          package: 3,
          token 
        }
      }
    ];
    
    const results = [];
    
    for (const method of searchMethods) {
      try {
        console.log(`🔍 Trying method: ${method.name}`);
        
        const response = await fetch(method.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(method.data).toString()
        });
        
        const responseText = await response.text();
        
        let foundDeposits = [];
        
        // Try to parse as JSON first
        try {
          const jsonData = JSON.parse(responseText);
          if (Array.isArray(jsonData)) {
            foundDeposits = jsonData.filter(item => 
              item.job_id == jobId || 
              item.JOB_ID == jobId ||
              (specificDepositId && (item.id == specificDepositId || item.ID == specificDepositId))
            );
          }
        } catch (e) {
          // If not JSON, search for our job/deposit IDs in text
          const jobMatch = responseText.includes(jobId);
          const depositMatch = specificDepositId ? responseText.includes(specificDepositId) : false;
          
          if (jobMatch || depositMatch) {
            foundDeposits.push({
              method: method.name,
              jobId: jobId,
              depositId: specificDepositId,
              found: 'text_match',
              context: responseText.substring(0, 500)
            });
          }
        }
        
        results.push({
          method: method.name,
          status: response.status,
          success: response.ok,
          foundDeposits: foundDeposits,
          responseSize: responseText.length,
          sample: responseText.substring(0, 300)
        });
        
      } catch (error) {
        results.push({
          method: method.name,
          error: error.message
        });
      }
    }
    
    return results;
    
  } catch (error) {
    return { error: error.message };
  }
}

// Trigger buffer sync for found deposits
async function triggerBufferSync(bufferedDeposits, token, hirehopDomain) {
  try {
    console.log('🚀 Triggering buffer sync...');
    
    // Try multiple sync trigger endpoints
    const syncEndpoints = [
      // Method 1: Manual export trigger
      {
        name: 'manual_export',
        url: `https://${hirehopDomain}/php_functions/manual_export.php`,
        data: {
          action: 'export_all',
          package_id: 3,
          type: 'deposits',
          force: true,
          token
        }
      },
      // Method 2: Buffer flush
      {
        name: 'buffer_flush',
        url: `https://${hirehopDomain}/php_functions/buffer_flush.php`,
        data: {
          accounting_package: 3,
          flush_all: true,
          token
        }
      },
      // Method 3: Direct export command
      {
        name: 'export_command',
        url: `https://${hirehopDomain}/php_functions/export_command.php`,
        data: {
          command: 'sync_buffer',
          package: 3,
          immediate: true,
          token
        }
      },
      // Method 4: Accounting sync trigger
      {
        name: 'accounting_sync_all',
        url: `https://${hirehopDomain}/php_functions/accounting_sync_all.php`,
        data: {
          package_id: 3,
          sync_type: 'buffer',
          token
        }
      }
    ];
    
    const results = [];
    
    for (const endpoint of syncEndpoints) {
      try {
        console.log(`🚀 Trying sync method: ${endpoint.name}`);
        
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(endpoint.data).toString()
        });
        
        const responseText = await response.text();
        
        results.push({
          method: endpoint.name,
          status: response.status,
          success: response.ok,
          response: responseText.substring(0, 200),
          containsSuccess: responseText.toLowerCase().includes('success'),
          containsError: responseText.toLowerCase().includes('error'),
          containsSync: responseText.toLowerCase().includes('sync')
        });
        
        // If we get a success response, log it prominently
        if (response.ok && !responseText.toLowerCase().includes('error')) {
          console.log(`✅ Sync method ${endpoint.name} appears successful`);
        }
        
      } catch (error) {
        results.push({
          method: endpoint.name,
          error: error.message
        });
      }
    }
    
    return results;
    
  } catch (error) {
    return { error: error.message };
  }
}

// Verify if deposits now have ACC_ID after sync
async function verifyDepositSync(jobId, specificDepositId, token, hirehopDomain) {
  try {
    console.log('✅ Verifying deposit sync status...');
    
    const encodedToken = encodeURIComponent(token);
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    
    const response = await fetch(billingUrl);
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    
    const billingData = await response.json();
    
    // Find all deposits for this job
    const deposits = billingData.rows?.filter(row => row.kind === 6) || [];
    
    const verification = {
      totalDeposits: deposits.length,
      syncedDeposits: 0,
      unsyncedDeposits: 0,
      details: []
    };
    
    deposits.forEach(deposit => {
      const accId = deposit.data?.ACC_ID || '';
      const exported = deposit.data?.exported || 0;
      const synced = accId !== '' && accId !== null;
      
      if (synced) {
        verification.syncedDeposits++;
      } else {
        verification.unsyncedDeposits++;
      }
      
      verification.details.push({
        depositId: deposit.data?.ID,
        amount: deposit.credit,
        description: deposit.desc,
        synced: synced,
        accId: accId,
        exported: exported,
        date: deposit.date
      });
    });
    
    // Focus on specific deposit if provided
    if (specificDepositId) {
      const specificDeposit = verification.details.find(d => d.depositId == specificDepositId);
      verification.specificDeposit = specificDeposit || { error: 'Deposit not found' };
    }
    
    return verification;
    
  } catch (error) {
    return { error: error.message };
  }
}
