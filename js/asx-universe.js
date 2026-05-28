// ============================================================
// ASX INDEX UNIVERSE LISTS
// Approximate constituents as of 2026 — rebalanced quarterly.
// Delisted or absent tickers are silently skipped by the scanner.
// 2026-05: removed IPL.AX (Incitec Pivot — delisted after 2023 demerger).
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
    'SHL.AX','WOR.AX','SOL.AX','ORG.AX','WGX.AX',
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
    'SHL.AX','WOR.AX','SOL.AX','ORG.AX','WGX.AX',
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
    'PDN.AX','DTL.AX','LOV.AX','GQG.AX','TNE.AX',
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
    'SHL.AX','WOR.AX','SOL.AX','ORG.AX','WGX.AX',
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
    'PDN.AX','DTL.AX','LOV.AX','GQG.AX','TNE.AX',
    // ASX 101–200
    'APE.AX','ADH.AX','DMP.AX','FLT.AX','KAR.AX',
    'PMV.AX','PPT.AX','MFG.AX','OML.AX','DOW.AX',
    'MMS.AX','CQR.AX','HDN.AX','HMC.AX','KGN.AX',
    'GOZ.AX','NCK.AX','ORA.AX','RFF.AX','RGN.AX',
    'RRL.AX','SDF.AX','CRN.AX','GEM.AX','BPT.AX',
    'BGA.AX','RMS.AX','MVF.AX','MTS.AX','NHC.AX',
    'SGM.AX','IDX.AX','OFX.AX','INA.AX','PNI.AX',
    'EVT.AX','IPH.AX','AFG.AX','WEB.AX','VEA.AX',
    'NIC.AX','GDF.AX','AOF.AX','SKC.AX','MCY.AX',
    'GNE.AX','KCN.AX','FBU.AX','CDP.AX','CMM.AX',
    'RWC.AX','CXO.AX','NWS.AX','DUG.AX','EMR.AX',
    'ALK.AX','GMD.AX','GTK.AX','HCW.AX','IMD.AX',
    'JDO.AX','LIC.AX','MEL.AX','MND.AX','PAR.AX',
    'PLT.AX','CIA.AX','SDR.AX','RSG.AX','SBM.AX',
    'SXL.AX','TYR.AX','UNI.AX','WPR.AX','NXL.AX',
    'AX1.AX','CEL.AX','ASB.AX','PPE.AX','WGN.AX',
    'CBO.AX','29M.AX','GWA.AX','IHD.AX','LRK.AX',
    'ABG.AX','CVW.AX','RAP.AX','RKN.AX','SMR.AX',
    'STX.AX','CUV.AX','MXI.AX','TBN.AX','AIS.AX',
    'BUB.AX','CHN.AX','CXL.AX','GRR.AX','SKN.AX',
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
