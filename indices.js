const FALLBACK = {
  sp500: [
    [1,"NVDA","Nvidia"],[2,"AAPL","Apple"],[3,"MSFT","Microsoft"],[4,"AMZN","Amazon"],[5,"META","Meta Platforms"],[6,"AVGO","Broadcom"],[7,"GOOGL","Alphabet"],[8,"GOOG","Alphabet Class C"],[9,"TSLA","Tesla"],[10,"LLY","Eli Lilly"],[11,"BRK-B","Berkshire Hathaway"],[12,"JPM","JPMorgan Chase"],[13,"WMT","Walmart"],[14,"V","Visa"],[15,"XOM","Exxon Mobil"],[16,"MA","Mastercard"],[17,"COST","Costco"],[18,"UNH","UnitedHealth"],[19,"ORCL","Oracle"],[20,"PG","Procter & Gamble"],[21,"HD","Home Depot"],[22,"NFLX","Netflix"],[23,"JNJ","Johnson & Johnson"],[24,"BAC","Bank of America"],[25,"CRM","Salesforce"],[26,"ABBV","AbbVie"],[27,"KO","Coca-Cola"],[28,"AMD","Advanced Micro Devices"],[29,"TMO","Thermo Fisher"],[30,"PEP","PepsiCo"]
  ],
  ndx100: [
    [1,"NVDA","Nvidia"],[2,"AAPL","Apple"],[3,"MSFT","Microsoft"],[4,"AMZN","Amazon"],[5,"META","Meta Platforms"],[6,"AVGO","Broadcom"],[7,"GOOGL","Alphabet"],[8,"TSLA","Tesla"],[9,"GOOG","Alphabet Class C"],[10,"COST","Costco"],[11,"NFLX","Netflix"],[12,"AMD","Advanced Micro Devices"],[13,"TMUS","T-Mobile"],[14,"CSCO","Cisco"],[15,"LIN","Linde"],[16,"PEP","PepsiCo"],[17,"QCOM","Qualcomm"],[18,"INTU","Intuit"],[19,"ADBE","Adobe"],[20,"ISRG","Intuitive Surgical"],[21,"AMGN","Amgen"],[22,"TXN","Texas Instruments"],[23,"BKNG","Booking"],[24,"SBUX","Starbucks"],[25,"MU","Micron"],[26,"ADI","Analog Devices"],[27,"INTC","Intel"],[28,"LRCX","Lam Research"],[29,"MDLZ","Mondelez"],[30,"PANW","Palo Alto Networks"]
  ],
};
const INDICES = {
  top100: { name: "市值 Top100", desc: "美股市值最大的100家公司" },
  sp500: { name: "标普500", desc: "S&P 500 指数成分股" },
  ndx100: { name: "纳指100", desc: "Nasdaq-100 指数成分股" },
};
export { FALLBACK, INDICES };
