// Netlify Function to get job details from HireHop
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  // Check if this is a GET request
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ message: 'Method not allowed' })
    };
  }

  // Get job ID from query parameters
  const jobId = event.queryStringParameters?.job;
  
  if (!jobId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Job ID is required' })
    };
  }

  try {
    // HireHop API credentials from environment variables
    const hireHopToken = process.env.HIREHOP_API_TOKEN;
    const hireHopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!hireHopToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ message: 'HireHop API token is not configured' })
      };
    }
    
    console.log(`Fetching job details for job ${jobId}`);
    
    // Define all the endpoints we need to call
    const endpoints = {
      // Basic job data
      jobData: `https://${hireHopDomain}/api/job_data.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Financial information
      financialData: `https://${hireHopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Billing information - most likely contains the deposit information
      billingData: `https://${hireHopDomain}/frames/tabs/billing.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Invoice data
      invoiceData: `https://${hireHopDomain}/api/job_invoices.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Payment data - try a different endpoint structure
      paymentsData: `https://${hireHopDomain}/api/job_payments.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`
    };
    
    // Log what we're doing
    console.log(`Making requests to HireHop for job ${jobId}`);
    
    // Create a collection of promises for all API calls
    const apiCalls = {
      jobData: axios.get(endpoints.jobData),
      financialData: axios.get(endpoints.financialData).catch(err => ({ data: null })), // Allow this to fail
      billingData: axios.get(endpoints.billingData).catch(err => ({ data: null })), // Allow this to fail
      invoiceData: axios.get(endpoints.invoiceData).catch(err => ({ data: null })), // Allow this to fail
      paymentsData: axios.get(endpoints.paymentsData).catch(err => ({ data: null })) // Allow this to fail
    };
    
    // Make all API calls in parallel
    const results = await Promise.all(Object.values(apiCalls));
    
    // Extract results
    const responses = {
      jobData: results[0].data,
      financialData: results[1].data,
      billingData: results[2].data,
      invoiceData: results[3].data,
      paymentsData: results[4].data
    };
    
    // Basic check if job data exists
    if (!responses.jobData || responses.jobData.error) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          message: 'Job not found or error retrieving job', 
          error: responses.jobData?.error || 'No job data returned'
        })
      };
    }
    
    // Extract all the data we need
    const job = responses.jobData;
    const financialData = responses.financialData || {};
    const billingData = responses.billingData || {};
    const invoiceData = Array.isArray(responses.invoiceData) ? responses.invoiceData : [];
    let paymentsData = Array.isArray(responses.paymentsData) ? responses.paymentsData : [];
    
    // Extract payments from billing data if available
    let deposits = [];
    let netTotal = 0;
    let totalPaid = 0;
    
    // Attempt to extract billing data - this might be HTML content
    if (typeof billingData === 'string' && billingData.includes('Deposit')) {
      // Try to parse the HTML to extract the deposit information
      console.log('Billing data is HTML, attempting to parse');
      
      try {
        // Make an additional request to get the billing data in a structured format
        // Try the job_deposits endpoint which might exist
        const depositsUrl = `https://${hireHopDomain}/api/job_deposits.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
        const depositsResponse = await axios.get(depositsUrl).catch(err => ({ data: [] }));
        
        if (Array.isArray(depositsResponse.data)) {
          deposits = depositsResponse.data;
          console.log(`Found ${deposits.length} deposits from deposits API`);
        }
      } catch (depositError) {
        console.log('Error fetching deposits:', depositError.message);
      }
    }
    
    // If we couldn't get deposits from the API, try one more endpoint
    if (deposits.length === 0) {
      try {
        // Try the billing list endpoint which might contain the deposits
        const billingListUrl = `https://${hireHopDomain}/frames/billing_list.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
        const billingListResponse = await axios.get(billingListUrl).catch(err => ({ data: null }));
        
        if (billingListResponse.data) {
          console.log('Got billing list data, attempting to extract deposits');
          
          // This might return structured JSON or HTML
          if (typeof billingListResponse.data === 'object') {
            // If it's JSON, try to extract deposits
            if (billingListResponse.data.items && Array.isArray(billingListResponse.data.items)) {
              deposits = billingListResponse.data.items.filter(item => 
                item.Description && (item.Description.includes('Deposit') || item.type === 'deposit')
              );
              console.log(`Found ${deposits.length} deposits from billing list items`);
            }
          }
        }
      } catch (billingListError) {
        console.log('Error fetching billing list:', billingListError.message);
      }
    }
    
    // If still no deposits found, make a direct request to the billing tab
    if (deposits.length === 0) {
      try {
        // This is a more direct way to access the billing data
        const billingTabUrl = `https://${hireHopDomain}/frames/billing_tab.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
        const billingTabResponse = await axios.get(billingTabUrl).catch(err => ({ data: null }));
        
        // Save the raw billing tab response for debugging
        const rawBillingTab = billingTabResponse.data;
        
        // Try to extract net total from the financial data
        if (financialData && typeof financialData === 'object') {
          if (financialData.total_revenue !== undefined) {
            netTotal = parseFloat(financialData.total_revenue || 0);
          }
        }
        
        // If we have raw billing tab data but can't parse it, we'll provide it for debugging
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            jobId,
            customerName: job.NAME || "Customer",
            customerEmail: job.EMAIL || null,
            totalAmount: 0, // We'll update this if extracted
            paidAmount: 0, // We'll update this if extracted
            remainingAmount: 0, // We'll update this if extracted
            depositAmount: 0, // We'll update this if extracted
            depositPaid: false,
            hireDuration: parseInt(job.DURATION_DAYS) || 0,
            requiresExcess: true,
            excessMethod: (parseInt(job.DURATION_DAYS) || 0) <= 4 ? 'pre-auth' : 'payment',
            rawBillingTab: typeof rawBillingTab === 'string' ? rawBillingTab : null,
            debug: {
              jobData: job,
              financialData: financialData,
              deposits: deposits,
              invoiceData: invoiceData,
              paymentsData: paymentsData
            }
          })
        };
      } catch (billingTabError) {
        console.log('Error fetching billing tab:', billingTabError.message);
      }
    }
    
    // Calculate hire duration from the job data
    let hireDuration = 0;
    
    if (job.DURATION_DAYS) {
      // Use the duration days from the job data if available
      hireDuration = parseInt(job.DURATION_DAYS);
    } else if (job.OUT_DATE && job.RETURN_DATE) {
      // Calculate duration from dates
      const startDate = new Date(job.OUT_DATE);
      const endDate = new Date(job.RETURN_DATE);
      hireDuration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1; // +1 to include both days
    }
    
    // Get VAT information
    // First check if VAT rate is specified in the job
    let vatRate = 0.20; // Default VAT rate of 20%
    
    // Check if standard tax rates are available
    if (job.standard_tax_rates && Array.isArray(job.standard_tax_rates) && job.standard_tax_rates.length > 0) {
      // Use the first tax rate (usually the standard VAT rate)
      const taxRate = job.standard_tax_rates[0][0]; // Get first tax rate
      if (taxRate && taxRate.RATE) {
        vatRate = parseFloat(taxRate.RATE) / 100; // Convert percentage to decimal
      }
    }
    
    // Check if job is VAT-exempt - this may need to be adjusted based on HireHop's actual data structure
    const isVatExempt = job.USE_SALES_TAX === "0" || parseFloat(job.DEFAULT_SALES_TAX) === 0;
    
    // If VAT exempt, set rate to 0
    if (isVatExempt) {
      vatRate = 0;
    }
    
    // Calculate total amount - try multiple sources
    if (netTotal === 0) {
      if (job.PRICE !== undefined) {
        netTotal = parseFloat(job.PRICE || 0);
      } else if (job.TOTAL_PRICE !== undefined) {
        netTotal = parseFloat(job.TOTAL_PRICE || 0);
      } else if (job.TOTAL !== undefined) {
        netTotal = parseFloat(job.TOTAL || 0);
      }
    }
    
    // Calculate VAT and gross amount
    const vatAmount = netTotal * vatRate;
    const grossTotalAmount = netTotal + vatAmount;
    
    // Calculate total paid from deposits/payments
    if (deposits.length > 0) {
      deposits.forEach(deposit => {
        if (deposit.AMOUNT) {
          totalPaid += parseFloat(deposit.AMOUNT || 0);
        } else if (deposit.amount) {
          totalPaid += parseFloat(deposit.amount || 0);
        } else if (deposit.Owed) {
          totalPaid += Math.abs(parseFloat(deposit.Owed || 0)); // Convert negative to positive
        } else if (deposit.owed) {
          totalPaid += Math.abs(parseFloat(deposit.owed || 0)); // Convert negative to positive
        }
      });
    }
    
    if (totalPaid === 0 && paymentsData.length > 0) {
      paymentsData.forEach(payment => {
        if (payment.AMOUNT) {
          totalPaid += parseFloat(payment.AMOUNT || 0);
        } else if (payment.amount) {
          totalPaid += parseFloat(payment.amount || 0);
        }
      });
    }
    
    // Assume payments in HireHop are also net
    const grossPaidAmount = totalPaid * (1 + vatRate);
    
    // Calculate remaining amount (gross)
    const grossRemainingAmount = grossTotalAmount - grossPaidAmount;
    
    // Determine deposit amount (25% or £100 of gross total, whichever is greater)
    // For bookings under £400 (gross), full payment is required
    let grossDepositAmount = 0;
    if (grossTotalAmount < 400) {
      grossDepositAmount = grossTotalAmount;
    } else {
      grossDepositAmount = Math.max(grossTotalAmount * 0.25, 100);
    }
    
    // Determine if deposit has been paid
    const depositPaid = grossPaidAmount >= grossDepositAmount;
    
    // Format amounts to 2 decimal places
    const formatAmount = (amount) => parseFloat(parseFloat(amount).toFixed(2));
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.NAME || "Customer",
      customerEmail: job.EMAIL || null, 
      totalAmount: formatAmount(grossTotalAmount),
      paidAmount: formatAmount(grossPaidAmount),
      remainingAmount: formatAmount(grossRemainingAmount),
      depositAmount: formatAmount(grossDepositAmount),
      depositPaid,
      hireDuration,
      requiresExcess: true, // Assuming all hires require excess
      excessMethod: hireDuration <= 4 ? 'pre-auth' : 'payment',
      vatInfo: {
        rate: vatRate,
        isExempt: isVatExempt,
        netTotal: formatAmount(netTotal),
        vatAmount: formatAmount(vatAmount),
        grossTotal: formatAmount(grossTotalAmount)
      },
      // Include debug info to help troubleshoot (can be removed in production)
      debug: {
        netTotal,
        totalPaid,
        jobDataFields: Object.keys(job),
        financialDataFields: typeof financialData === 'object' ? Object.keys(financialData) : [],
        deposits: deposits,
        paymentsCount: paymentsData.length,
        invoicesCount: invoiceData.length
      }
    };
    
    console.log('Processed job data successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData)
    };
  } catch (error) {
    console.log('Error:', error);
    
    // Determine the appropriate error message and status code
    let statusCode = 500;
    let message = 'Error fetching job details';
    let errorDetails = error.message;
    
    if (error.response) {
      // The request was made and the server responded with a status code
      statusCode = error.response.status;
      message = `HireHop API Error: ${error.response.statusText}`;
      errorDetails = error.response.data || error.message;
    } else if (error.request) {
      // The request was made but no response was received
      message = 'No response received from HireHop API';
      errorDetails = 'Check API URL and token';
    }
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({ 
        message, 
        error: errorDetails,
        url: `https://${process.env.HIREHOP_DOMAIN || 'hirehop.net'}/api`
      })
    };
  }
};
