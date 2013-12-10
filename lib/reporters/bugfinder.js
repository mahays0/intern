// summary:
//	Implements single-fault spectrum-based fault localization to identify source code statements causing exhibited test failures.
//	While the theory of multiple-fault SBFL has been described and tested for viability, it is not implemented yet due to the complexity of rotating the matrix.

define([
	'intern/lib/util',
	'dojo/has',
	'dojo/has!host-node?dojo/node!istanbul/lib/collector',
	'dojo/has!host-node?dojo/node!istanbul/lib/report/text'
], function (util, has, Collector, Reporter) {
	if (typeof console !== 'object') {
		// IE<10 does not provide a global console object when Developer Tools is turned off
		return {};
	}

	var PASS=0;
	var FAIL=1;
	var NOTEXECUTED=0;
	var EXECUTED=1;
	var hitspectra={diffs:[],results:[],statements:{}};
	var cachedCoverage={};
	var lastCoverage={};
	
	function computeCoverageDiff(latestCoverage){
		// summary:
		//		Reads in the latest coverage and determines which lines have been executed since the last time coverage was checked.
		var file=null;
		var statement=null;
		var diff={};
		var latestCounts=0;
		var cachedCounts=0;
		var isExecuted=false;
		
		// for each file in coverage
		for(file in latestCoverage){
			//console.log(file);
			// for each statement
			for(statement in latestCoverage[file].s){
				// compute diff in # executions since last time
				latestCounts=latestCoverage[file].s[statement];
				isExecuted=false;
				if(cachedCoverage[file]&&cachedCoverage[file].s[statement]){
					cachedCounts=cachedCoverage[file].s[statement];
					if(latestCounts > cachedCounts){
						// flag as executed by this test case
						var lineno=latestCoverage[file].statementMap[statement].start.line;
						//console.log("Re-executed:",file,lineno);
						isExecuted=true;
					}else if(latestCounts < cachedCounts){
						// coverage data was wiped?? good gravy people...
						// start over...
						//cachedCoverage={};
						//return computeCoverageDiff(latestCoverage);
					}else{
						// not executed
						isExecuted=false;
					}
				}else{
					// no cached data
					isExecuted=latestCounts>0;
				}
				if(!diff[file]){
					diff[file]={s:{}};
				}
				diff[file].s[statement]=isExecuted?EXECUTED:NOTEXECUTED;
			}
		}
		// deep copy
		cachedCoverage=JSON.parse(JSON.stringify(latestCoverage));
		// return diff
		return diff;
	}
	
	function updateHitSpectra(test,failed){
		try{
			test.remote._wd.execute('return typeof __internCoverage !== "undefined" && JSON.stringify(__internCoverage)', function (error, returnValue) {
				if (error) {
					dfd.reject(error);
					return;
				}

				// returnValue might be falsy on a page with no coverage data, so don't try to publish coverage
				// results to prevent things from breaking
				var latestCoverage=JSON.parse(returnValue);
				var diff=computeCoverageDiff(latestCoverage);
				hitspectra.diffs.push(diff);
				hitspectra.results.push(failed);
			});
			console.log("Trying to get coverage");
		}catch(e){
			console.error(e);
		}
	}
	
	
	
	var hasGrouping = 'group' in console && 'groupEnd' in console;

	var consoleReporter = {
		'/suite/start': hasGrouping ? function (suite) {
			console.group(suite.name);
		} : null,

		'/suite/end': function (suite) {
			var file="";
			var statement="";
			var i=0;
			try{
			var numTests = suite.numTests,
				numFailedTests = suite.numFailedTests;
			console[numFailedTests ? 'warn' : 'info'](numTests - numFailedTests + '/' + numTests + ' tests passed');
			if(hasGrouping){ console.groupEnd(suite.name); }
			if(numFailedTests){
				console.log("Starting fault localization");
				// now that all statement data is available, flatten accumulated diffs into full hit spectra
				// use latest coverage to get full index of files/statements
				var latestCoverage = cachedCoverage;
				//console.log(latestCoverage);
				var similarity=[];
				// for each file in coverage
				for(file in latestCoverage){
					//console.log(file+latestCoverage[file].s);
					// for each statement
					for(statement in latestCoverage[file].s){
						// look up source line
						var lineno=latestCoverage[file].statementMap[statement].start.line;
						var sid=file+":"+lineno;
						// find relevant diffs
						hitspectra.statements[sid]=[];
						var dotproduct=0;
						var magstatement=0;
						var magresult=0;
						// for each test case
						for(i=0; i<hitspectra.diffs.length; i++){
							var diff=hitspectra.diffs[i];
							var result=hitspectra.results[i];
							magresult+=result;
							if(diff[file]&&diff[file].s[statement]==EXECUTED){
								// statement magnitude always increments by 1
								magstatement++;
								// because statement is executed, dot product will always increment by result
								dotproduct+=result;
							}else{
								// statement is not executed, so dot product will never increment
							}
						}
						// compute cosine similarity
						var cosine=dotproduct/(Math.sqrt(magstatement*magresult));
						//if(file=="dojo/string.js"){
						//	console.log(sid,dotproduct,magstatement,magresult);
						//}
						similarity.push({sid: sid, similarity: cosine});
					}
				}
				if(similarity.length>0){
					// determine top k suspicious lines
					similarity=similarity.sort(function(a,b){
						return b.similarity-a.similarity;
					});
					console.warn("Top lines most likely causing test failures:");
					var topsim=similarity[0].similarity;
					i=0; // js hint complaining about i being undefined in this scope (why?)
					for(i=0; i<similarity.length; i++){
						var line=similarity[i];
						if(line.similarity!=topsim) break;
						console.warn(line.sid+": "+(line.similarity*100).toFixed(1)+"%");
					}
				}else{
					console.warn("Not enough coverage data.");
				}
			}
			}catch(e){
				console.error(e);
			}
		},

		'/suite/error': function (suite) {
			console.warn('SUITE ERROR: in ' + suite.id);
			util.logError(suite.error);
			if (suite.error.relatedTest) {
				console.error('Related test: ' + (hasGrouping ? suite.error.relatedTest.name : suite.error.relatedTest.id));
			}
		},
		
		'/test/pass': function (test) {
			console.log('PASS: ' + (hasGrouping ? test.name : test.id) + ' (' + test.timeElapsed + 'ms)');
			updateHitSpectra(test,PASS);
		},

		'/test/fail': function (test) {
			console.error('FAIL: ' + (hasGrouping ? test.name : test.id) + ' (' + test.timeElapsed + 'ms)');
			util.logError(test.error);
			updateHitSpectra(test,FAIL);
		}
	};

	if (has('host-node')) {
		consoleReporter['/coverage'] = function (sessionId, coverage) {
			var collector = new Collector();
			collector.add(coverage);

			// add a newline between test results and coverage results for prettier output
			console.log('');

			(new Reporter()).writeReport(collector, true);
		};
	}

	return consoleReporter;
});
