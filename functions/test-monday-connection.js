// test-monday-connection.js - CORRECTED to use proper Monday.com search API
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    console.log('🔍 Testing Monday.com connection...');
    console.log('Board ID:', mondayBoardId);
    console.log('API Key present:', !!mondayApiKey);
    
    if (!mondayApiKey || !mondayBoardId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Missing credentials',
          hasApiKey: !!mondayApiKey,
          hasBoardId: !!mondayBoardId
        })
      };
    }
    
    // Test 1: Basic API connectivity
    console.log('📋 Test 1: Basic API connectivity...');
    const basicQuery = `
      query {
        me {
          name
          email
        }
      }
    `;
    
    const basicResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey,
        'API-Version': '2023-10'  // Use specific API version for items_page_by_column_values
      },
      body: JSON.stringify({ query: basicQuery })
    });
    
    const basicResult = await basicResponse.json();
    console.log('Basic API result:', basicResult);
    
    // Test 2: Board access with columns
    console.log('📋 Test 2: Board access...');
    const boardQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          id
          name
          columns {
            id
            title
            type
          }
        }
      }
    `;
    
    const boardResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({ query: boardQuery })
    });
    
    const boardResult = await boardResponse.json();
    console.log('Board access result:', boardResult);
    
    // Test 3: CORRECTED - Use items_page_by_column_values to search for job 13997
    console.log('📋 Test 3: CORRECTED - Using items_page_by_column_values to search for job 13997...');
    const searchQuery = `
      query {
        items_page_by_column_values(
          board_id: ${mondayBoardId}
          columns: [
            {
              column_id: "text7"
              column_values: ["13997"]
            }
          ]
          limit: 10
        ) {
          cursor
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    `;
    
    const searchResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey,
        'API-Version': '2023-10'  // Required for items_page_by_column_values
      },
      body: JSON.stringify({ query: searchQuery })
    });
    
    const searchResult = await searchResponse.json();
    console.log('CORRECTED search result:', JSON.stringify(searchResult, null, 2));
    
    // Parse search results
    const foundItems = searchResult.data?.items_page_by_column_values?.items || [];
    const foundJob = foundItems.length > 0 ? foundItems[0] : null;
    
    // Test 4: Get a small sample of items to see what text7 values exist
    console.log('📋 Test 4: Getting sample items to see existing text7 values...');
    const sampleQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          items_page(limit: 20) {
            items {
              id
              name
              column_values(ids: ["text7"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;
    
    const sampleResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: sampleQuery })
    });
    
    const sampleResult = await sampleResponse.json();
    console.log('Sample items result:', JSON.stringify(sampleResult, null, 2));
    
    // Extract sample text7 values
    const sampleItems = sampleResult.data?.boards?.[0]?.items_page?.items || [];
    const sampleText7Values = sampleItems.map(item => {
      const text7Column = item.column_values.find(col => col.id === 'text7');
      return {
        itemId: item.id,
        name: item.name,
        text7Value: text7Column?.text || 'EMPTY',
        text7Raw: text7Column?.value || 'NULL'
      };
    });
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        tests: {
          basicApi: {
            success: !basicResult.errors,
            user: basicResult.data?.me,
            errors: basicResult.errors
          },
          boardAccess: {
            success: !boardResult.errors,
            board: boardResult.data?.boards?.[0],
            errors: boardResult.errors
          },
          jobSearchCorrected: {
            success: !searchResult.errors,
            foundJob13997: !!foundJob,
            foundItemsCount: foundItems.length,
            jobDetails: foundJob,
            searchErrors: searchResult.errors,
            cursor: searchResult.data?.items_page_by_column_values?.cursor
          },
          sampleItems: {
            success: !sampleResult.errors,
            totalSampled: sampleText7Values.length,
            itemsWithText7: sampleText7Values,
            errors: sampleResult.errors
          }
        },
        analysis: {
          mondayConnection: !basicResult.errors && !boardResult.errors,
          job13997Found: !!foundJob,
          text7ColumnExists: !!boardResult.data?.boards?.[0]?.columns?.find(col => col.id === 'text7'),
          searchApiWorking: !searchResult.errors,
          sampleText7Values: sampleText7Values.map(item => item.text7Value).filter(val => val !== 'EMPTY')
        },
        recommendations: foundJob ? 
          ['✅ Monday.com connection working!', '✅ Job 13997 FOUND using proper search API!', '🔧 Ready to add Monday.com to webhook'] :
          ['✅ Monday.com connection working', '✅ Search API working', `❌ Job 13997 not found. Sample text7 values: ${sampleText7Values.map(item => item.text7Value).filter(val => val !== 'EMPTY').slice(0, 5).join(', ')}`, '🔍 Check if job number format is different']
      })
    };
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Test failed', 
        details: error.message 
      })
    };
  }
};
