// test-xero-sync.js - Comprehensive test for Xero sync solutions
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    console.log('🎯 XERO SYNC TEST - Starting comprehensive sync test');
    
    // Get test parameters
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId') || '13997'; // Default test job
    const testAmount = parseFloat(params.get('amount')) || 25.00; // Test amount
    const solution = params.get('solution') || 'all'; // Which solution to test
    
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    console.log(`Testing Xero sync for job ${jobId} with amount £${testAmount}`);
    
    // STEP 1: Check current Xero configuration
    console.log('📋 STEP 1: Checking Xero configuration...');
    const xeroConfig = await checkXeroConfiguration(token, hirehopDomain);
    
    // STEP 2: Create test deposit with different strategies
    console.log('💰 STEP 2: Creating test deposits with different strategies...');
    const testResults = [];
    
    if (solution === 'all' || solution === '1') {
      console.log('🔄 Testing Solution 1: Force Approval Status');
      const result1 = await testSolution1_ForceApproval(jobId, testAmount + 0.01, token, hirehopDomain);
      testResults.push({ solution: 1, name: 'Force Approval Status', ...result1 });
    }
    
    if (solution === 'all' || solution === '2') {
      console.log('🔄 Testing Solution 2: Multiple Sync Triggers');
      const result2 = await testSolution2_MultipleTriggers(jobId, testAmount + 0.02, token, hirehopDomain);
      testResults.push({ solution: 2, name: 'Multiple Sync Triggers', ...result2 });
    }
    
    if (solution === 'all' || solution === '3') {
      console.log('🔄 Testing Solution 3: Buffer Check and Force');
      const result3 = await testSolution3_BufferForce(jobId, testAmount + 0.03, token, hirehopDomain);
      testResults.push({ solution: 3, name: 'Buffer Check and Force', ...result3 });
    }
    
    // STEP 3: Monitor results for 30 seconds
    console.log('⏳ STEP 3: Monitoring sync results...');
    const monitoringResults = await monitorSyncResults(testResults, token, hirehopDomain, jobId);
    
    // STEP 4: Generate comprehensive report
    const report = {
      timestamp: new Date().toISOString(),
      jobId,
      testAmount,
      xeroConfiguration: xeroConfig,
      solutions: testResults.map((result, index) => ({
        ...result,
        monitoring: monitoringResults[index]
      })),
      recommendations: generateRecommendations(testResults, monitoringResults),
      nextSteps: [
        'Deploy the most successful solution to production',
        'Monitor real payments for successful Xero sync',
        'Contact HireHop support if all solutions fail'
      ]
    };
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2)
    };
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Test failed', 
        details: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// Check Xero configuration and settings
async function checkXeroConfiguration(token, hirehopDomain) {
  try {
    console.log('🔍 Checking Xero configuration...');
    
    // Try to get accounting settings
    const encodedToken = encodeURIComponent(token);
    const settingsUrl = `https://${hirehopDomain}/php_functions/accounting_settings.php?token=${encodedToken}`;
    
    const response = await fetch(settingsUrl);
    let config = { status: 'unknown' };
    
    if (response.ok) {
      const settingsText = await response.text();
      config = {
        status: 'accessible',
        hasXero: settingsText.toLowerCase().includes('xero'),
        hasLiveMode: settingsText.toLowerCase().includes('live'),
        hasBuffered: settingsText.toLowerCase().includes('buffer'),
        responseSize: settingsText.length
      };
    } else {
      config = {
        status: 'inaccessible',
        httpStatus: response.status
      };
    }
    
    return config;
  } catch (error) {
    return {
      status: 'error',
      error: error.message
    };
  }
}

// Solution 1: Force approval status for immediate sync
async function testSolution1_ForceApproval(jobId, amount, token, hirehopDomain) {
  try {
    console.log(`💰 Solution 1: Creating deposit with forced approval (£${amount})`);
    
    const currentDate = new Date().toISOString().split('T')[0];
    const description = `${jobId} - test-approval-${Date.now()}`;
    
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Test: Solution 1 - ${Date.now()}`,
      ACC_ACCOUNT_ID: 267,
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: 1822,
      // Force approval flags
      STATUS: 'approved',
      APPROVED: 1,
      SYNC_NOW: true,
      FORCE_SYNC: true,
      'CURRENCY[CODE]': 'GBP',
      'CURRENCY[SYMBOL]': '£',
      'CURRENCY[DECIMALS]': 2,
      'CURRENCY[MULTIPLIER]': 1,
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    return {
      success: response.ok && parsedResponse.hh_id,
      depositId: parsedResponse.hh_id || null,
      response: parsedResponse,
      httpStatus: response.status,
      amount: amount
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      amount: amount
    };
  }
}

// Solution 2: Multiple sync triggers
async function testSolution2_MultipleTriggers(jobId, amount, token, hirehopDomain) {
  try {
    console.log(`💰 Solution 2: Creating deposit with multiple sync triggers (£${amount})`);
    
    // First create the deposit normally
    const currentDate = new Date().toISOString().split('T')[0];
    const description = `${jobId} - test-triggers-${Date.now()}`;
    
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Test: Solution 2 - ${Date.now()}`,
      ACC_ACCOUNT_ID: 267,
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: 1822,
      'CURRENCY[CODE]': 'GBP',
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    if (response.ok && parsedResponse.hh_id) {
      // Now trigger multiple sync mechanisms
      const syncTriggers = await triggerMultipleSyncEndpoints(
        jobId, 
        parsedResponse.hh_id, 
        token, 
        hirehopDomain
      );
      
      return {
        success: true,
        depositId: parsedResponse.hh_id,
        response: parsedResponse,
        syncTriggers: syncTriggers,
        amount: amount
      };
    } else {
      return {
        success: false,
        response: parsedResponse,
        httpStatus: response.status,
        amount: amount
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      amount: amount
    };
  }
}

// Solution 3: Buffer check and force
async function testSolution3_BufferForce(jobId, amount, token, hirehopDomain) {
  try {
    console.log(`💰 Solution 3: Creating deposit and forcing buffer sync (£${amount})`);
    
    // Create deposit normally
    const currentDate = new Date().toISOString().split('T')[0];
    const description = `${jobId} - test-buffer-${Date.now()}`;
    
    const depositData = {
      ID: 0,
      DATE: currentDate,
      DESCRIPTION: description,
      AMOUNT: amount,
      MEMO: `Test: Solution 3 - ${Date.now()}`,
      ACC_ACCOUNT_ID: 267,
      ACC_PACKAGE_ID: 3,
      JOB_ID: jobId,
      CLIENT_ID: 1822,
      'CURRENCY[CODE]': 'GBP',
      token: token
    };
    
    const response = await fetch(`https://${hirehopDomain}/php_functions/billing_deposit_save.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(depositData).toString()
    });
    
    const responseText = await response.text();
    let parsedResponse;
    
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      parsedResponse = { rawResponse: responseText };
    }
    
    if (response.ok && parsedResponse.hh_id) {
      // Wait 3 seconds then check buffer and force sync
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const bufferCheck = await checkBufferAndTriggerSync(
        jobId, 
        parsedResponse.hh_id, 
        token, 
        hirehopDomain
      );
      
      return {
        success: true,
        depositId: parsedResponse.hh_id,
        response: parsedResponse,
        bufferCheck: bufferCheck,
        amount: amount
      };
    } else {
      return {
        success: false,
        response: parsedResponse,
        httpStatus: response.status,
        amount: amount
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      amount: amount
    };
  }
}

// Trigger multiple sync endpoints
async function triggerMultipleSyncEndpoints(jobId, depositId, token, hirehopDomain) {
  const endpoints = [
    {
      name: 'accounting_sync',
      url: `https://${hirehopDomain}/php_functions/accounting_sync.php`,
      data: { deposit_id: depositId, job_id: jobId, package_id: 3, token }
    },
    {
      name: 'billing_export',
      url: `https://${hirehopDomain}/php_functions/billing_export.php`,
      data: { deposit_id: depositId, export_to_accounting: true, token }
    },
    {
      name: 'force_sync',
      url: `https://${hirehopDomain}/php_functions/force_sync.php`,
      data: { billing_id: depositId, force: true, token }
    }
  ];
  
  const results = [];
  
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(endpoint.data).toString()
      });
      
      const responseText = await response.text();
      results.push({
        endpoint: endpoint.name,
        success: response.ok,
        status: response.status,
        response: responseText.substring(0, 200) // First 200 chars
      });
    } catch (error) {
      results.push({
        endpoint: endpoint.name,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
}

// Check buffer and trigger sync
async function checkBufferAndTriggerSync(jobId, depositId, token, hirehopDomain) {
  try {
    // Check for buffer/export endpoints
    const bufferEndpoints = [
      `https://${hirehopDomain}/php_functions/invoices_to_be_exported.php`,
      `https://${hirehopDomain}/php_functions/export_buffer.php`,
      `https://${hirehopDomain}/frames/accounting_export.php`
    ];
    
    const results = [];
    
    for (const url of bufferEndpoints) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ 
            deposit_id: depositId, 
            action: 'export', 
            token 
          }).toString()
        });
        
        const responseText = await response.text();
        results.push({
          url: url.split('/').pop(),
          success: response.ok,
          status: response.status,
          containsDepositId: responseText.includes(depositId),
          response: responseText.substring(0, 150)
        });
      } catch (error) {
        results.push({
          url: url.split('/').pop(),
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  } catch (error) {
    return { error: error.message };
  }
}

// Monitor sync results over time
async function monitorSyncResults(testResults, token, hirehopDomain, jobId) {
  const monitoringResults = [];
  
  for (let i = 0; i < testResults.length; i++) {
    const test = testResults[i];
    
    if (!test.success || !test.depositId) {
      monitoringResults.push({ status: 'skipped', reason: 'deposit creation failed' });
      continue;
    }
    
    console.log(`⏳ Monitoring deposit ${test.depositId} for 15 seconds...`);
    
    const checks = [];
    
    // Check immediately, after 5s, 10s, and 15s
    for (const delay of [0, 5000, 10000, 15000]) {
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      try {
        const syncStatus = await checkDepositSyncStatus(jobId, test.depositId, token, hirehopDomain);
        checks.push({
          timeElapsed: delay / 1000,
          ...syncStatus
        });
        
        if (syncStatus.synced) {
          console.log(`✅ Deposit ${test.depositId} synced to Xero after ${delay/1000}s!`);
          break;
        }
      } catch (error) {
        checks.push({
          timeElapsed: delay / 1000,
          error: error.message
        });
      }
    }
    
    const finalStatus = checks[checks.length - 1];
    monitoringResults.push({
      depositId: test.depositId,
      checks: checks,
      finalSynced: finalStatus.synced || false,
      timeToSync: finalStatus.synced ? finalStatus.timeElapsed : null
    });
  }
  
  return monitoringResults;
}

// Check deposit sync status
async function checkDepositSyncStatus(jobId, depositId, token, hirehopDomain) {
  try {
    const encodedToken = encodeURIComponent(token);
    const billingUrl = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
    
    const response = await fetch(billingUrl);
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    
    const billingData = await response.json();
    
    const deposit = billingData.rows?.find(row => 
      row.kind === 6 && row.data?.ID === depositId
    );
    
    if (deposit) {
      const accId = deposit.data?.ACC_ID || '';
      const exported = deposit.data?.exported || 0;
      
      return {
        found: true,
        synced: accId !== '' && accId !== null,
        accId: accId,
        exported: exported,
        hasAccData: !!(deposit.data?.ACC_DATA && Object.keys(deposit.data.ACC_DATA).length > 0)
      };
    } else {
      return { found: false };
    }
  } catch (error) {
    return { error: error.message };
  }
}

// Generate recommendations based on test results
function generateRecommendations(testResults, monitoringResults) {
  const recommendations = [];
  
  // Check which solutions worked
  const successfulSolutions = testResults
    .map((test, index) => ({ 
      ...test, 
      monitoring: monitoringResults[index] 
    }))
    .filter(test => test.monitoring?.finalSynced);
  
  if (successfulSolutions.length > 0) {
    recommendations.push(`✅ SUCCESS: Solution ${successfulSolutions[0].solution} (${successfulSolutions[0].name}) successfully synced to Xero`);
    recommendations.push(`🚀 DEPLOY: Use Solution ${successfulSolutions[0].solution} in production webhook`);
    
    if (successfulSolutions[0].monitoring.timeToSync <= 5) {
      recommendations.push(`⚡ FAST SYNC: Sync completed in ${successfulSolutions[0].monitoring.timeToSync}s - excellent performance`);
    }
  } else {
    recommendations.push('⚠️ NO IMMEDIATE SUCCESS: None of the solutions achieved immediate Xero sync');
    recommendations.push('🔍 INVESTIGATE: Check HireHop Settings → Accounts → Xero configuration');
    recommendations.push('📞 CONTACT: Reach out to HireHop support about API user Xero sync limitations');
    recommendations.push('🔄 ALTERNATIVE: Consider using human user API token instead of API-only user');
  }
  
  // Check if any deposits were created successfully
  const createdDeposits = testResults.filter(test => test.success).length;
  if (createdDeposits > 0) {
    recommendations.push(`💰 DEPOSITS CREATED: ${createdDeposits} test deposits created successfully`);
    recommendations.push(`📋 CHECK MANUALLY: Verify these deposits in HireHop billing tab`);
  }
  
  return recommendations;
}
