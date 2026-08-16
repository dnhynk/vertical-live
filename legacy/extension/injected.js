(function () {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const response = await originalFetch(...args);

        // 유튜브 실시간 데이터 API URL 감지
        if (typeof args[0] === 'string' && args[0].includes('get_live_chat')) {
            const clone = response.clone();
            clone.json().then(data => {
                // 유튜브 JSON 내부 파싱 (구조는 바뀔 수 있음)
                if (data.continuationContents?.liveChatContinuation?.actions) {
                    const actions = data.continuationContents.liveChatContinuation.actions;

                    actions.forEach(action => {
                        // 1. 이모지/리액션 패킷 찾기
                        // (유튜브 데이터 구조상 emoji 카테고리가 섞여 들어옵니다)
                        const emojiData = action.addLiveChatTickerItemAction?.item?.liveChatTickerSponsorItemRenderer;

                        // 하트나 특정 반응이 있을 때
                        if (emojiData || Math.random() < 0.05) { // 테스트용: 실제론 복잡한 경로 파싱 필요
                            // content.js로 데이터 토스
                            window.postMessage({
                                type: "PIKACHU_PACKET",
                                payload: { type: 'HEART', value: '💖' }
                            }, "*");
                        }
                    });
                }
            }).catch(() => { });
        }

        return response;
    };
})();