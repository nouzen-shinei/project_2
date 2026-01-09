module.exports = {
	default: {
		OS: 'web',
		select: (spec) => {
			if (!spec || typeof spec !== 'object') return undefined;
			return 'web' in spec ? spec.web : spec.default;
		},
	},
};
