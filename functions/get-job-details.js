// get-job-details.js - Retrieves job information from HireHop
const fetch = require('node-fetch');

// Netlify function handler
exports.handler = async (event, context) => {
  try {
    // Parse the job ID from the query string
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId');
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    // Get environment variables
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    // Fetch basic job data
    const jobUrl = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${token}`;
    const jobResponse = await fetch(jobUrl);
    const jobData = await jobResponse.json();
    
    // Fetch financial data
    const financeUrl = `https://${hirehopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${token}`;
    const financeResponse = await fetch(financeUrl);
    const financeText = await financeResponse.text();
    
    // Parse financial data
    let financial = {};
    try {
      if (!isNaN(financeText)) {
        financial.total_revenue = parseFloat(financeText);
      } else {
        financial = JSON.parse(financeText);
      }
    } catch (e) {
      console.log(`Could not parse financial data: ${e.message}`);
      financial = { total_revenue: 0 };
    }
    
    // Get payment history using the working endpoint from Zapier code
    const itemsUrl = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${token}`;
    const itemsResponse = await fetch(itemsUrl);
    const itemsText = await itemsResponse.text();
    
    let items = [];
    try {
      const itemsData = JSON.parse(itemsText);
      if (itemsData.items && Array.isArray(itemsData.items)) {
        items = itemsData.items;
      }
    } catch (e) {
      console.log(`Could not parse items data: ${e.message}`);
    }
    
    // Try to get payment history
    const paymentsUrl = `https://${hirehopDomain}/frames/payment_receipts_list.php?job=${jobId}&token=${token}`;
    let payments = [];
    let totalPaid = 0;
    
    try {
      const paymentsResponse = await fetch(paymentsUrl);
      const paymentsText = await paymentsResponse.text();
      
      try {
        const paymentsData = JSON.parse(paymentsText);
        if (paymentsData && Array.isArray(paymentsData.payments)) {
          payments = paymentsData.payments;
          // Calculate total paid amount
          totalPaid = payments.reduce((sum, payment) => {
            return sum + (parseFloat(payment.amount) || 0);
          }, 0);
        }
      } catch (e) {
        console.log(`Could not parse payments JSON: ${e.message}`);
      }
    } catch (e) {
      console.log(`Could not fetch payments: ${e.message}`);
    }
    
    // Calculate amounts
    const totalAmount = financial.total_revenue || 0;
    const remainingAmount = totalAmount - totalPaid;
    
    // Calculate deposit amount based on business rules
    // 25% or £100, whichever is greater; full payment for jobs under £400
    let depositAmount = totalAmount * 0.25;
    if (depositAmount < 100) {
      depositAmount = 100;
    }
    if (totalAmount < 400) {
      depositAmount = totalAmount;
    }
    
    // Determine if deposit is already paid
    const depositPaid = totalPaid >= depositAmount;
    
    // Determine excess payment method based on hire duration
    const startDate = new Date(jobData.job_start);
    const endDate = new Date(jobData.job_end);
    const hireDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    const excessMethod = hireDays <= 4 ? 'pre-auth' : 'payment';
    
    // Construct the response
    const result = {
      jobId,
      jobData,
      financial: {
        totalAmount,
        totalPaid,
        remainingAmount,
        depositAmount,
        depositPaid,
        balanceAmount: remainingAmount,
      },
      customer: {
        name: jobData.customer_name,
        email: jobData.customer_email,
      },
      excess: {
        amount: 1200, // £1,200 excess amount
        method: excessMethod
      },
      hireDuration: {
        startDate: jobData.job_start,
        endDate: jobData.job_end,
        days: hireDays
      },
      payments,
      items
    };
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(result)
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
