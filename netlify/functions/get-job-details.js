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
    const hireHopDomain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
    
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
      
      // Items on the job
      itemsData: `https://${hireHopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Invoices
      invoicesData: `https://${hireHopDomain}/api/job_invoices.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Payments - based on your Zapier script and documentation
      paymentsData: `https://${hireHopDomain}/api/job_payments.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`
    };
    
    // Log what we're doing
    console.log(`Making requests to HireHop for job ${jobId}`);
    
    // Create a collection of promises for all API calls
    const apiCalls = {
      jobData: axios.get(endpoints.jobData),
      financialData: axios.get(endpoints.financialData).catch(err => ({ data: null })), // Allow this to fail
      itemsData: axios.get(endpoints.itemsData).catch(err => ({ data: null })), // Allow this to fail
      invoicesData: axios.get(endpoints.invoicesData).catch(err => ({ data: null })), // Allow this to fail
      paymentsData: axios.get(endpoints.paymentsData).catch(err => ({ data: null })) // Allow this to fail
    };
    
    // Make all API calls in parallel
    const results = await Promise.all(Object.values(apiCalls));
    
    // Extract results
    const responses = {
      jobData: results[0].data,
      financialData: results[1].data,
      itemsData: results[2].data,
      invoicesData: results[3].data,
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
    const itemsData = responses.itemsData || {};
    const invoicesData = responses.invoicesData || {};
    let paymentsData = responses.paymentsData || [];
    
    // Ensure payments is an array
    if (!Array.isArray(paymentsData)) {
      paymentsData = [];
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
    
    // Calculate net total amount - try multiple sources
    let netTotalAmount = 0;
    
    // Try financial data first
    if (financialData && typeof financialData === 'object') {
      if (financialData.total_revenue !== undefined) {
        netTotalAmount = parseFloat(financialData.total_revenue || 0);
      } else if (financialData.invoice_total !== undefined) {
        netTotalAmount = parseFloat(financialData.invoice_total || 0);
      }
    }
    
    // If we couldn't get it from financial data, check invoices
    if (netTotalAmount === 0 && Array.isArray(invoicesData)) {
      invoicesData.forEach(invoice => {
        if (invoice.TOTAL) {
          netTotalAmount += parseFloat(invoice.TOTAL || 0);
        }
      });
    }
    
    // If we still don't have a total, try to get it from job data
    if (netTotalAmount === 0) {
      if (job.PRICE !== undefined) {
        netTotalAmount = parseFloat(job.PRICE || 0);
      } else if (job.TOTAL_PRICE !== undefined) {
        netTotalAmount = parseFloat(job.TOTAL_PRICE || 0);
      } else if (job.TOTAL !== undefined) {
        netTotalAmount = parseFloat(job.TOTAL || 0);
      }
    }
    
    // Calculate VAT and gross amount
    const vatAmount = netTotalAmount * vatRate;
    const grossTotalAmount = netTotalAmount + vatAmount;
    
    // Calculate paid amounts from the payments array
    let netPaidAmount = 0;
    
    // Process payments from the dedicated payments endpoint
    if (Array.isArray(paymentsData) && paymentsData.length > 0) {
      paymentsData.forEach(payment => {
        if (payment.AMOUNT) {
          netPaidAmount += parseFloat(payment.AMOUNT || 0);
        } else if (payment.amount) {
          netPaidAmount += parseFloat(payment.amount || 0);
        }
      });
    }
    
    // Check for paid amounts in financial data as a backup
    if (netPaidAmount === 0 && financialData && typeof financialData === 'object') {
      if (financialData.amount_paid !== undefined) {
        netPaidAmount = parseFloat(financialData.amount_paid || 0);
      }
    }
    
    // Assume payments in HireHop are also net
    const grossPaidAmount = netPaidAmount * (1 + vatRate);
    
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
    
    // Get customer email if available
    const customerEmail = job.EMAIL || null;
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.NAME || "Customer",
      customerEmail, 
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
        netTotal: formatAmount(netTotalAmount),
        vatAmount: formatAmount(vatAmount),
        grossTotal: formatAmount(grossTotalAmount)
      },
      // Include debug info to help troubleshoot (can be removed in production)
      debug: {
        jobDataFields: Object.keys(job),
        financialDataFields: typeof financialData === 'object' ? Object.keys(financialData) : [],
        paymentsCount: Array.isArray(paymentsData) ? paymentsData.length : 0,
        paymentsData: Array.isArray(paymentsData) ? paymentsData : null, // Include full payment data for debugging
        invoicesCount: Array.isArray(invoicesData) ? invoicesData.length : 0
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
        url: `https://${process.env.HIREHOP_DOMAIN || 'myhirehop.com'}/api`
      })
    };
  }
};
