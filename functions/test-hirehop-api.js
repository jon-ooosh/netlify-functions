// test-hirehop-api.js - Complete rewrite with deposit discovery
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    // Get query parameters
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId');
    const endpoint = params.get('endpoint');
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    // Get environment variables
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'HireHop API token not configured' })
      };
    }
    
    // URL encode the token properly
    const encodedToken = encodeURIComponent(token);
    
    let url;
    let responseData;
    
    // Determine which endpoint to test
    switch (endpoint) {
      case 'job_data':
        url = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
        break;
      
      case 'job_margins':
        url = `https://${hirehopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${encodedToken}`;
        break;
      
      case 'items_list':
        url = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`;
        break;
      
      case 'payment_receipts':
        url = `https://${hirehopDomain}/frames/payment_receipts_list.php?job=${jobId}&token=${encodedToken}`;
        break;
        
      case 'billing_list':
        url = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
        break;
        
      case 'billing_grid':
        url = `https://${hirehopDomain}/frames/grids/billing_grid.php?job_id=${jobId}&token=${encodedToken}`;
        break;
      
      case 'billing_api':
        url = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
        break;

      case 'get_job_details_v2':
        url = `https://ooosh-tours-payment-page.netlify.app/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
        break;
        
      case 'test_stripe_session':
        try {
          const testData = {
            jobId: jobId,
            paymentType: 'deposit',
            successUrl: 'https://example.com/success',
            cancelUrl: 'https://example.com/cancel'
          };
          
          const stripeResponse = await fetch(`https://ooosh-tours-payment-page.netlify.app/.netlify/functions/create-stripe-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testData)
          });
          
          const responseText = await stripeResponse.text();
          
          try {
            responseData = JSON.parse(responseText);
          } catch (e) {
            responseData = { error: 'Invalid JSON response', rawResponse: responseText };
          }
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'POST to create-stripe-session (deposit)',
              statusCode: stripeResponse.status,
              contentType: stripeResponse.headers.get('content-type'),
              responseSize: responseText.length,
              response: responseData,
              rawResponse: responseText.substring(0, 1000)
            })
          };
        } catch (error) {
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Error calling create-stripe-session',
              error: error.message,
              response: { error: error.message }
            })
          };
        }

      case 'test_van_detection':
        try {
          // Test van detection specifically
          const vehicleCategoryIds = [369, 370, 371];
          
          // Try multiple endpoints to find job items
          const endpoints = [
            `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/api/job_items.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/php_functions/job_items.php?job_id=${jobId}&token=${encodedToken}`
          ];
          
          let itemsData = null;
          let workingUrl = null;
          let allResults = {};
          
          // Try each endpoint
          for (let i = 0; i < endpoints.length; i++) {
            const testUrl = endpoints[i];
            try {
              console.log(`Trying endpoint ${i + 1}: ${testUrl.substring(0, testUrl.indexOf('token'))}`);
              const response = await fetch(testUrl);
              const responseText = await response.text();
              
              allResults[`endpoint_${i + 1}`] = {
                url: testUrl.substring(0, testUrl.indexOf('token')) + 'token=[HIDDEN]',
                status: response.status,
                contentType: response.headers.get('content-type'),
                responseSize: responseText.length,
                startsWithHtml: responseText.trim().startsWith('<'),
                startsWithJson: responseText.trim().startsWith('{') || responseText.trim().startsWith('[')
              };
              
              // Try to parse as JSON
              if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                try {
                  const parsed = JSON.parse(responseText);
                  if (parsed && (Array.isArray(parsed) || (parsed.items && Array.isArray(parsed.items)))) {
                    itemsData = Array.isArray(parsed) ? parsed : parsed.items;
                    workingUrl = testUrl;
                    allResults[`endpoint_${i + 1}`].success = true;
                    allResults[`endpoint_${i + 1}`].itemCount = itemsData.length;
                    break;
                  }
                } catch (parseError) {
                  allResults[`endpoint_${i + 1}`].parseError = parseError.message;
                }
              }
              
              allResults[`endpoint_${i + 1}`].rawSample = responseText.substring(0, 200);
              
            } catch (fetchError) {
              allResults[`endpoint_${i + 1}`] = {
                url: testUrl.substring(0, testUrl.indexOf('token')) + 'token=[HIDDEN]',
                fetchError: fetchError.message
              };
            }
          }
          
          // Check for vehicles if we found items
          let vanOnHire = false;
          let foundVehicles = [];
          
          if (itemsData && Array.isArray(itemsData)) {
            foundVehicles = itemsData.filter(item => {
              const categoryId = parseInt(item.CATEGORY_ID || item.category_id || item.categoryId || 0);
              return vehicleCategoryIds.includes(categoryId);
            });
            vanOnHire = foundVehicles.length > 0;
          }
          
          responseData = {
            vanOnHire: vanOnHire,
            workingEndpoint: workingUrl ? workingUrl.substring(0, workingUrl.indexOf('token')) + 'token=[HIDDEN]' : 'None found',
            itemsCount: itemsData ? itemsData.length : 0,
            vehicleCategoryIds: vehicleCategoryIds,
            foundVehicles: foundVehicles,
            allEndpointResults: allResults,
            sampleItems: itemsData ? itemsData.slice(0, 3) : null // First 3 items for debugging
          };
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Van Detection Test - Multiple Endpoints',
              statusCode: 200,
              contentType: 'application/json',
              response: responseData
            })
          };
        } catch (error) {
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Van Detection Test - Error',
              error: error.message,
              response: { error: error.message }
            })
          };
        }

      // 🎯 NEW: TEST DEPOSIT CREATION WITH FULL PARAMETERS
      case 'test_deposit_creation':
        try {
          console.log('🎯 TESTING DEPOSIT CREATION WITH FULL PARAMETERS');
          
          // Test the working endpoint with all required deposit fields
          const depositData = {
            job: jobId, // 🎯 FIXED: Changed from main_id to job
            type: 1, // Job type
            kind: 6, // 6 = deposit/payment received
            amount: 50.00, // Test amount
            credit: 50.00, // Credit amount (money received)
            debit: 0, // No debit for deposits
            date: new Date().toISOString().split('T')[0], // Today's date
            desc: `Job ${jobId} - Test Deposit`, // Description
            description: `Job ${jobId} - Test Deposit`,
            method: 'Card/Stripe',
            bank_id: 267, // Stripe GBP bank account
            reference: 'test_' + Date.now(),
            owing: 0, // No amount owing for deposits
            paid: 50.00, // Full amount paid
            token: token
          };
          
          console.log('💰 Testing deposit creation with data:', { ...depositData, token: '[HIDDEN]' });
          
          const response = await fetch(`https://${hirehopDomain}/php_functions/billing_save.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(depositData).toString()
          });
          
          const responseText = await response.text();
          
          let parsedResponse;
          try {
            parsedResponse = JSON.parse(responseText);
          } catch (e) {
            parsedResponse = responseText;
          }
          
          responseData = {
            testType: 'Deposit Creation Test',
            endpoint: 'billing_save.php with kind=6 (deposit)',
            status: response.status,
            ok: response.ok,
            responseSize: responseText.length,
            isJson: responseText.trim().startsWith('{'),
            response: parsedResponse,
            rawResponse: responseText,
            depositData: { ...depositData, token: '[HIDDEN]' },
            analysis: {
              hasError: parsedResponse && parsedResponse.error !== undefined,
              errorCode: parsedResponse && parsedResponse.error,
              hasRows: parsedResponse && parsedResponse.rows !== undefined,
              suggestedSuccess: response.ok && !responseText.toLowerCase().includes('error')
            }
          };
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Deposit Creation Test',
              statusCode: 200,
              contentType: 'application/json',
              response: responseData
            })
          };
          
        } catch (error) {
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Deposit Creation Test Error',
              error: error.message,
              response: { error: error.message }
            })
          };
        }

      // 🎯 SYSTEMATIC DEPOSIT ENDPOINT DISCOVERY
      case 'find_deposit_endpoints':
        try {
          console.log('🔍 SYSTEMATIC DEPOSIT ENDPOINT DISCOVERY');
          
          // We know billing_list.php works, so test similar patterns for deposits
          const testEndpoints = [
            // Pattern 1: Similar to working billing_list.php
            `https://${hirehopDomain}/php_functions/deposit_list.php?main_id=${jobId}&type=1&token=${encodedToken}`,
            `https://${hirehopDomain}/php_functions/deposit_save.php?main_id=${jobId}&token=${encodedToken}`,
            
            // Pattern 2: Frames directory (like your working endpoints)
            `https://${hirehopDomain}/frames/deposit_list.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/frames/deposit_save.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/frames/deposits.php?job=${jobId}&token=${encodedToken}`,
            
            // Pattern 3: API directory
            `https://${hirehopDomain}/api/deposit_list.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/api/deposits.php?job=${jobId}&token=${encodedToken}`,
            
            // Pattern 4: Payment receipts (might handle deposits too)
            `https://${hirehopDomain}/frames/payment_receipts_save.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/php_functions/payment_save.php?main_id=${jobId}&token=${encodedToken}`,
            
            // Pattern 5: Direct job payment endpoints
            `https://${hirehopDomain}/php_functions/job_payment.php?job=${jobId}&token=${encodedToken}`,
            `https://${hirehopDomain}/api/job_payment.php?job=${jobId}&token=${encodedToken}`,
            
            // Pattern 6: Billing save with different parameters (might create deposits not invoices)
            `https://${hirehopDomain}/php_functions/billing_save.php?main_id=${jobId}&type=2&token=${encodedToken}`,
            `https://${hirehopDomain}/php_functions/billing_save.php?main_id=${jobId}&type=6&token=${encodedToken}`
          ];
          
          let discoveryResults = [];
          
          for (let i = 0; i < testEndpoints.length; i++) {
            const testUrl = testEndpoints[i];
            const endpointName = `Endpoint ${i + 1}`;
            
            try {
              console.log(`Testing ${endpointName}: ${testUrl.substring(0, testUrl.indexOf('token'))}`);
              
              const response = await fetch(testUrl);
              const responseText = await response.text();
              
              const result = {
                endpoint: endpointName,
                url: testUrl.substring(0, testUrl.indexOf('token')) + 'token=[HIDDEN]',
                status: response.status,
                ok: response.ok,
                responseSize: responseText.length,
                isHtml: responseText.trim().startsWith('<html'),
                isJson: responseText.trim().startsWith('{') || responseText.trim().startsWith('['),
                containsError: responseText.toLowerCase().includes('error'),
                containsSuccess: responseText.toLowerCase().includes('success'),
                firstChars: responseText.substring(0, 150)
              };
              
              discoveryResults.push(result);
              
              // If we get a non-404 response that's not HTML error page, log it prominently
              if (response.status !== 404 && !responseText.includes('<title>HireHop</title>')) {
                console.log(`🎯 POTENTIAL DEPOSIT ENDPOINT FOUND: ${endpointName}`);
                console.log('Response details:', result);
              }
              
            } catch (error) {
              discoveryResults.push({
                endpoint: endpointName,
                url: testUrl.substring(0, testUrl.indexOf('token')) + 'token=[HIDDEN]',
                error: error.message
              });
            }
          }
          
          responseData = {
            message: 'Deposit endpoint discovery complete',
            jobId: jobId,
            totalEndpointsTested: testEndpoints.length,
            results: discoveryResults,
            workingCandidates: discoveryResults.filter(r => 
              r.status && r.status !== 404 && !r.isHtml && !r.containsError
            ),
            summary: {
              total404s: discoveryResults.filter(r => r.status === 404).length,
              nonHtmlResponses: discoveryResults.filter(r => !r.isHtml && r.status !== 404).length,
              jsonResponses: discoveryResults.filter(r => r.isJson).length,
              successIndicators: discoveryResults.filter(r => r.containsSuccess).length
            }
          };
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Deposit Endpoint Discovery',
              statusCode: 200,
              contentType: 'application/json',
              response: responseData
            })
          };
          
        } catch (error) {
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'Deposit Discovery Error',
              error: error.message,
              response: { error: error.message }
            })
          };
        }

      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            error: 'Invalid endpoint parameter', 
            validOptions: ['job_data', 'job_margins', 'items_list', 'payment_receipts', 'billing_list', 'billing_grid', 'billing_api', 'get_job_details_v2', 'test_stripe_session', 'test_van_detection', 'find_deposit_endpoints', 'test_deposit_creation'] 
          })
        };
    }
    
    console.log(`Testing HireHop endpoint: ${url.substring(0, url.indexOf('token=') + 10)}...`);
    
    // Make the API request (for non-special endpoints)
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');
    
    // Get response as text first
    const responseText = await response.text();
    
    // Try to parse as JSON if it looks like JSON
    try {
      if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
        responseData = JSON.parse(responseText);
      } else {
        responseData = responseText;
      }
    } catch (e) {
      // If parsing fails, return the raw text
      responseData = responseText;
    }
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url.includes('token=') ? url.substring(0, url.indexOf('token=')) + 'token=[HIDDEN]' : url,
        statusCode: response.status,
        contentType,
        responseSize: responseText.length,
        response: responseData,
        rawResponse: responseText.substring(0, 1000) // First 1000 chars for debugging
      })
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
