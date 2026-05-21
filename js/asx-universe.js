// ============================================================
// ASX INDEX UNIVERSE LISTS
// Approximate constituents as of 2025 — rebalanced quarterly.
// Delisted or absent tickers are silently skipped by the scanner.
// ============================================================

const _ASX_UNIVERSES = {
  asx20: [
    'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX',
    'ANZ.AX','WES.AX','MQG.AX','GMG.AX','RIO.AX',
    'WOW.AX','FMG.AX','TLS.AX','WDS.AX','ALL.AX',
    'REA.AX','TCL.AX','COL.AX','MIN.AX','STO.AX',
  ],

  asx50: [
    // ASX 20
    'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX',
    'ANZ.AX','WES.AX','MQG.AX','GMG.AX','RIO.AX',
    'WOW.AX','FMG.AX','TLS.AX','WDS.AX','ALL.AX',
    'REA.AX','TCL.AX','COL.AX','MIN.AX','STO.AX',
    // ASX 21–50
    'QBE.AX','SUN.AX','IAG.AX','MPL.AX','RMD.AX',
    'XRO.AX','CPU.AX','APA.AX','AGL.AX','ORI.AX',
    'BXB.AX','SCG.AX','GPT.AX','VCX.AX','DXS.AX',
    'LLC.AX','QAN.AX','NXT.AX','ASX.AX','ILU.AX',
    'SHL.AX','WOR.AX','IPL.AX','SOL.AX','ORG.AX',
    'AMP.AX','SGP.AX','NST.AX','EVN.AX','AMC.AX',
  ],

  asx100: [
    // ASX 50 (above)
    'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX',
    'ANZ.AX','WES.AX','MQG.AX','GMG.AX','RIO.AX',
    'WOW.AX','FMG.AX','TLS.AX','WDS.AX','ALL.AX',
    'REA.AX','TCL.AX','COL.AX','MIN.AX','STO.AX',
    'QBE.AX','SUN.AX','IAG.AX','MPL.AX','RMD.AX',
    'XRO.AX','CPU.AX','APA.AX','AGL.AX','ORI.AX',
    'BXB.AX','SCG.AX','GPT.AX','VCX.AX','DXS.AX',
    'LLC.AX','QAN.AX','NXT.AX','ASX.AX','ILU.AX',
    'SHL.AX','WOR.AX','IPL.AX','SOL.AX','ORG.AX',
    'AMP.AX','SGP.AX','NST.AX','EVN.AX','AMC.AX',
    // ASX 51–100
    'ALX.AX','JBH.AX','TWE.AX','HVN.AX','BSL.AX',
    'JHX.AX','CHC.AX','WTC.AX','PLS.AX','RHC.AX',
    'ALD.AX','CAR.AX','EBO.AX','ANN.AX','CGF.AX',
    'MGR.AX','SFR.AX','TAH.AX','BAP.AX','NHF.AX',
    'HLS.AX','BEN.AX','BOQ.AX','IGO.AX','LYC.AX',
    'PME.AX','SEK.AX','TPG.AX','ALS.AX','CWY.AX',
    'SUL.AX','CCL.AX','DRR.AX','ELD.AX','HUB.AX',
    'REH.AX','ARG.AX','BWP.AX','CLW.AX','ARB.AX',
    'IFL.AX','AZJ.AX','CIP.AX','NEC.AX','CMW.AX',
    'AWC.AX','DTL.AX','LOV.AX','GQG.AX','TNE.AX',
  ],

  asx200: [
    // ASX 100 (above)
    'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX',
    'ANZ.AX','WES.AX','MQG.AX','GMG.AX','RIO.AX',
    'WOW.AX','FMG.AX','TLS.AX','WDS.AX','ALL.AX',
    'REA.AX','TCL.AX','COL.AX','MIN.AX','STO.AX',
    'QBE.AX','SUN.AX','IAG.AX','MPL.AX','RMD.AX',
    'XRO.AX','CPU.AX','APA.AX','AGL.AX','ORI.AX',
    'BXB.AX','SCG.AX','GPT.AX','VCX.AX','DXS.AX',
    'LLC.AX','QAN.AX','NXT.AX','ASX.AX','ILU.AX',
    'SHL.AX','WOR.AX','IPL.AX','SOL.AX','ORG.AX',
    'AMP.AX','SGP.AX','NST.AX','EVN.AX','AMC.AX',
    'ALX.AX','JBH.AX','TWE.AX','HVN.AX','BSL.AX',
    'JHX.AX','CHC.AX','WTC.AX','PLS.AX','RHC.AX',
    'ALD.AX','CAR.AX','EBO.AX','ANN.AX','CGF.AX',
    'MGR.AX','SFR.AX','TAH.AX','BAP.AX','NHF.AX',
    'HLS.AX','BEN.AX','BOQ.AX','IGO.AX','LYC.AX',
    'PME.AX','SEK.AX','TPG.AX','ALS.AX','CWY.AX',
    'SUL.AX','CCL.AX','DRR.AX','ELD.AX','HUB.AX',
    'REH.AX','ARG.AX','BWP.AX','CLW.AX','ARB.AX',
    'IFL.AX','AZJ.AX','CIP.AX','NEC.AX','CMW.AX',
    'AWC.AX','DTL.AX','LOV.AX','GQG.AX','TNE.AX',
    // ASX 101–200
    'APE.AX','ADH.AX','DMP.AX','FLT.AX','KAR.AX',
    'PMV.AX','PPT.AX','MFG.AX','OML.AX','DOW.AX',
    'MMS.AX','CQR.AX','HDN.AX','HMC.AX','KGN.AX',
    'GOZ.AX','NCK.AX','ORA.AX','RFF.AX','RGN.AX',
    'RRL.AX','SDF.AX','CRN.AX','GEM.AX','BPT.AX',
    'BGA.AX','ABP.AX','MVF.AX','MTS.AX','NHC.AX',
    'CSR.AX','IDX.AX','OFX.AX','INA.AX','NSR.AX',
    'EVT.AX','IPH.AX','AFG.AX','WEB.AX','MQA.AX',
    'NAM.AX','GDF.AX','AOF.AX','SKC.AX','MCY.AX',
    'GNE.AX','URW.AX','FBU.AX','CDP.AX','CMM.AX',
    'COE.AX','CXO.AX','DHG.AX','DUG.AX','EMR.AX',
    'FFX.AX','GMD.AX','GTK.AX','HCW.AX','IMD.AX',
    'JDO.AX','LIC.AX','MEL.AX','MOZ.AX','PAR.AX',
    'PLT.AX','RBL.AX','RED.AX','RSG.AX','SCX.AX',
    'SXL.AX','TYR.AX','UNI.AX','WPR.AX','GNX.AX',
    'CAI.AX','CEL.AX','ASB.AX','PPE.AX','BLD.AX',
    'CBO.AX','ECX.AX','ESG.AX','IHD.AX','LRK.AX',
    'NBL.AX','QMS.AX','RAP.AX','RKN.AX','SMR.AX',
    'STX.AX','SWM.AX','MXI.AX','ADI.AX','AIS.AX',
    'BUB.AX','CHN.AX','CXL.AX','OVH.AX','SKN.AX',
  ],
};

function getUniverseTickers(key) {
  return _ASX_UNIVERSES[key] || [];
}

const ASX_UNIVERSE_META = {
  asx20:  { label: 'ASX 20',  desc: 'Top 20 by market cap — blue chips only' },
  asx50:  { label: 'ASX 50',  desc: 'Top 50 — major industrials & financials' },
  asx100: { label: 'ASX 100', desc: 'Top 100 — large & mid-cap liquid stocks' },
  asx200: { label: 'ASX 200', desc: 'Benchmark 200 — broadest liquid universe' },
};
