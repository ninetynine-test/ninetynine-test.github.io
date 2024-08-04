Prism.hooks.add('complete', function (env) {
	// works only for <code> wrapped inside <pre> (not inline)
	var pre = env.element.parentNode;
	var clsReg = /\s*\bline-numbers\b\s*/;
	if (
		!pre || !/pre/i.test(pre.nodeName) ||
		// Abort only if nor the <pre> nor the <code> have the class
		(!clsReg.test(pre.className) && !clsReg.test(env.element.className))
	) {
		return;
	}

	if ( env.element.querySelector(".line-numbers-rows") ) {
		// Abort if line numbers already exists
		return;
	}

	if (clsReg.test(env.element.className)) {
		// Remove the class "line-numbers" from the <code>
		env.element.className = env.element.className.replace(clsReg, '');
	}
	if (!clsReg.test(pre.className)) {
		// Add the class "line-numbers" to the <pre>
		pre.className += ' line-numbers';
	}

    // Wrap each code line inside a <div> and a <span>. The <span> is required to be
    // able to copy/paste the whitespaces.
    var codeLines = env.code.split(/\r\n?|\n/g);
    env.element.innerHTML = codeLines.map(function(line) {
    	return '<div class="code-line"><span>' + (line !== '' ? line : '<br />') + '</span></div>';
    }).join('');
    codeLines = env.element.getElementsByClassName('code-line');
	var linesNum = codeLines.length;
    
	var lineNumbersWrapper = document.createElement('span');
	lineNumbersWrapper.className = 'line-numbers-rows';
    
	for(var i = 0; i < linesNum; i++) {
		var span = document.createElement('span');
		span.style.height = codeLines[i].offsetHeight + 'px';
		lineNumbersWrapper.appendChild(span)
	}

	if (pre.hasAttribute('data-start')) {
		pre.style.counterReset = 'linenumber ' + (parseInt(pre.getAttribute('data-start'), 10) - 1);
	}

	env.element.appendChild(lineNumbersWrapper);
});